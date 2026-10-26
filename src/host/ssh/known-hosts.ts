/**
 * known_hosts 校验（OpenSSH 兼容）。
 *
 * 设计要点（这是本插件安全上最容易做错的地方）：
 *   1. **先探测、再询问、最后真正连接**。ssh2 的 `hostVerifier` 是同步回调，
 *      没法在里面问用户。所以探测连接里直接 `return false`：该回调发生在密钥
 *      交换阶段、**早于任何用户认证**，因此被拒绝的连接不会把密码/私钥送出去。
 *   2. 指纹按 OpenSSH 的 `SHA256:<base64 去 padding>` 表示，用户能直接与
 *      `ssh-keyscan` / 服务器管理员给的值对照。
 *   3. 指纹变化一律拒绝（不提供「忽略一次」），只能由用户手动删除旧条目。
 *      一个能点掉的警告等于没有警告。
 *   4. 同时读 `~/.ssh/known_hosts`（只读）与插件自己的 `<data>/known_hosts`
 *      （读写），这样用户已有的信任关系不需要重复确认。
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HostKeyEntry {
  /** 逗号分隔的主机名，与 OpenSSH 一致（非标准端口写成 [host]:port）。 */
  hosts: string[];
  keyType: string;
  keyBase64: string;
}

export type VerifyResult =
  | { status: "trusted"; fingerprint: string }
  | { status: "unknown"; fingerprint: string }
  | { status: "changed"; fingerprint: string; previous: string };

/** OpenSSH 风格的指纹：`SHA256:` + base64(sha256(rawKey))，去掉 `=` 填充。 */
export function fingerprintOf(rawKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "")}`;
}

export class KnownHosts {
  private constructor(
    private readonly ownPath: string,
    private readonly entries: HostKeyEntry[],
  ) {}

  /** 写入串行链：保证「读→拼→写」不交错（见 writeAtomic）。 */
  private writeChain: Promise<void> = Promise.resolve();

  static async load(dataDir?: string): Promise<KnownHosts> {
    const ownPath = dataDir ? join(dataDir, "known_hosts") : join(homedir(), ".pi-terminal", "known_hosts");
    const entries: HostKeyEntry[] = [];
    for (const path of [join(homedir(), ".ssh", "known_hosts"), ownPath]) {
      const text = await readFile(path, "utf8").catch(() => "");
      entries.push(...parseKnownHosts(text));
    }
    return new KnownHosts(ownPath, entries);
  }

  /**
   * 用现成条目构造（**仅测试用**）：把 known_hosts 的内容当成字符串交给它，
   * 不必碰真实文件，就能验证「同类型才冲突」这类判定。
   */
  static fromText(text: string, ownPath = join(homedir(), ".pi-terminal", "known_hosts")): KnownHosts {
    return new KnownHosts(ownPath, parseKnownHosts(text));
  }

  /**
   * 用探测连接拿到的原始 host key 判定信任状态。
   * `port` 非 22 时按 OpenSSH 约定写成 `[host]:port`。
   */
  verify(host: string, port: number, rawKey: Buffer, keyType?: string): VerifyResult {
    const fingerprint = fingerprintOf(rawKey);
    const keyBase64 = rawKey.toString("base64");
    const target = hostKeyName(host, port);
    const candidates = this.entries.filter((entry) => entry.hosts.includes(target));
    if (candidates.length === 0) return { status: "unknown", fingerprint };

    for (const entry of candidates) {
      if (entry.keyBase64 === keyBase64) return { status: "trusted", fingerprint };
    }

    /*
     * 只有**同一种算法**的旧条目才构成「指纹变了」。
     *
     * 一台主机同时提供 ed25519 与 rsa 是常态（用户的 ~/.ssh/known_hosts 里往往
     * 只记了其中一种）。旧实现把所有类型的条目都当成冲突来源：ssh2 这次协商到
     * rsa、而记录里只有 ed25519 时，就会被误报成「host key changed」并拒绝连接。
     * 那是**误拒**，不是安全漏洞 —— 但它让「明明没换过服务器却连不上」。
     *
     * 类型未知时（调用方没给）退回旧行为：宁可按冲突处理，也不放过真正的替换。
     */
    // 类型优先用调用方给的（真实链路里由 key 的 wire format 直接读出）；拿不到就
    // 尝试从 key 里认，**认不出就按「未知类型」处理** —— 这时把它与所有条目比较，
    // 宁可误报一次「变了」也绝不放行真正的替换。
    const type = keyType || guessKeyType(rawKey);
    const sameType = type
      ? candidates.filter((entry) => entry.keyType === type)
      : candidates;
    if (sameType.length === 0) return { status: "unknown", fingerprint };
    return { status: "changed", fingerprint, previous: fingerprintFromBase64(sameType[0]!.keyBase64) };
  }

  /** 记录一条新的信任。写入是原子的（临时文件 + rename）。 */
  async add(host: string, port: number, rawKey: Buffer, keyType = guessKeyType(rawKey) || "ssh-ed25519"): Promise<void> {
    const entry: HostKeyEntry = {
      hosts: [hostKeyName(host, port)],
      keyType,
      keyBase64: rawKey.toString("base64"),
    };
    this.entries.push(entry);
    await mkdir(dirname(this.ownPath), { recursive: true });
    const line = `${entry.hosts.join(",")} ${entry.keyType} ${entry.keyBase64}\n`;
    const existing = await readFile(this.ownPath, "utf8").catch(() => "");
    await this.commit((existing) => `${existing}${line}`);
  }

  /** 供「指纹变化」处理流程使用的移除操作。 */
  async remove(host: string, port: number): Promise<void> {
    const target = hostKeyName(host, port);
    await this.commit((text) => {
      const kept = text
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.split(/\s+/)[0]?.split(",").includes(target))
        .join("\n");
      return kept ? `${kept}\n` : "";
    });
  }

  /**
   * 原子写 + 串行化。
   *
   * 临时文件名必须**每次唯一**：只用 `process.pid` 时，同一进程内两个连接
   * 同时 `add`（例如一次确认唤醒两条并发连接）会写同一个临时文件，先完成
   * 的那次 rename 把它挪走，后一次 rename 就 ENOENT —— 表现是「指纹确认了
   * 但其中一条连接报错」。
   *
   * 另外整个「读→拼→写」必须在一条链上跑完，否则两个 add 都基于同一份旧
   * 文本拼接，后写的会把先写的那条条目覆盖掉（用户发现 known_hosts 里只
   * 记了一台主机）。
   */
  private commit(update: (current: string) => string): Promise<void> {
    const run = this.writeChain.then(async () => {
      await mkdir(dirname(this.ownPath), { recursive: true });
      const current = await readFile(this.ownPath, "utf8").catch(() => "");
      const temp = `${this.ownPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temp, update(current), { mode: 0o600 });
      try {
        await replaceWithRetry(temp, this.ownPath);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    });
    // 链条本身不能因为一次失败就断掉，否则后续写入永远被拒。
    this.writeChain = run.catch(() => undefined);
    return run;
  }
}

/**
 * 用临时文件替换目标文件，并对 Windows 的瞬时占用重试。
 *
 * POSIX 上 `rename` 是原子的「替换」；Windows 上它同样会替换已存在的目标，
 * 但只要目标文件此刻被别的句柄打开（杀毒软件扫描、索引服务、另一个正在
 * 读 `known_hosts` 的连接），就会返回 `EPERM`/`EBUSY`/`EACCES`。这类占用
 * 通常只持续几毫秒，所以退避重试几次比直接失败合理得多 —— 否则用户看到
 * 的是「指纹确认了，另一条连接报 EPERM」。
 */
async function replaceWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EEXIST";
      if (!transient || attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

export function parseKnownHosts(text: string): HostKeyEntry[] {
  const out: HostKeyEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostField, keyType, keyBase64] = parts;
    if (!hostField || !keyType || !keyBase64) continue;
    // 跳过通配符条目（`*`、`?`）：本插件只按精确主机匹配，避免误信任。
    const hosts = hostField.split(",").filter((h) => h && !/[*?!]/.test(h) && !h.startsWith("|"));
    if (hosts.length === 0) continue;
    out.push({ hosts, keyType, keyBase64 });
  }
  return out;
}

export function hostKeyName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function fingerprintFromBase64(keyBase64: string): string {
  return fingerprintOf(Buffer.from(keyBase64, "base64"));
}

/**
 * 尽力认出 key 的算法名；**认不出返回空串**（而不是瞎猜一个）。
 *
 * 认不出的代价必须落在「更保守」那一侧：写 known_hosts 时用一个占位名，校验时
 * 与所有条目比较。如果像早期实现那样随手 `return "ssh-rsa"`，那么一台只记录了
 * ed25519 的主机在类型猜错时就会被判成「新类型首次出现」—— 该拦的替换被放过去了。
 */
function guessKeyType(rawKey: Buffer): string {
  // wire format：4 字节长度 + 算法名
  if (rawKey.length > 4) {
    const length = rawKey.readUInt32BE(0);
    if (length > 0 && length <= 64 && 4 + length <= rawKey.length) {
      const name = rawKey.subarray(4, 4 + length).toString("ascii");
      if (/^[a-z0-9@.-]+$/i.test(name)) return name;
    }
  }
  const text = rawKey.toString("binary");
  if (text.includes("ssh-ed25519")) return "ssh-ed25519";
  if (text.includes("ecdsa-sha2")) return "ecdsa-sha2-nistp256";
  if (text.includes("ssh-rsa")) return "ssh-rsa";
  return "";
}
