/**
 * 凭据加密存储。
 *
 * 宿主**没有**把 `secrets.*` API 暴露给插件，所以这一步由插件自己承担。
 * 策略按平台降级，且降级必须可解释：
 *
 *   Windows  DPAPI (`CryptProtectData`) —— 绑定当前用户，只有本机同用户的
 *            进程能解开。用一个极小的 PowerShell 封装调用，避免引入原生模块。
 *   macOS    `security add-generic-password -w` / `find-generic-password -w`。
 *   Linux    `secret-tool`（libsecret）；不可用时退化为「主密钥文件」：
 *            主密钥同样经 OS 保护（文件 0600，且在 secret-tool 缺失时明确
 *            告知用户当前强度较低），内容用 AES-256-GCM 加密。
 *
 * 明文只在两个瞬间存在：解密后立即用于建立 SSH 连接；以及用户点「小眼睛」
 * 时按次返回。两者都不写日志、不进会话状态、不随工具输出外泄。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SecretKind = "password" | "passphrase";

export interface SecretStoreStatus {
  /** 当前实际生效的保护方式，用于设置页如实告知用户。 */
  backend: "dpapi" | "keychain" | "libsecret" | "passphrase-file";
  /** 是否可能弱于「OS 密钥库」，UI 要提示。 */
  degraded: boolean;
  detail: string;
}

const SERVICE = "pi-terminal";

export class SecretStore {
  private constructor(
    private readonly dataDir: string,
    private readonly status: SecretStoreStatus,
  ) {}

  static async open(dataDir: string): Promise<SecretStore> {
    await mkdir(dirname(join(dataDir, "secrets", "x")), { recursive: true });
    return new SecretStore(dataDir, await detectBackend());
  }

  /**
   * **仅供测试**：用指定后端打开（不探测本机）。
   *
   * 密钥库分支（keychain / libsecret）在 Windows 上根本跑不到，而「删除是否真的
   * 清了密钥库条目」恰恰只有它们才有意义。脚本用假的 `security` / `secret-tool`
   * 可执行文件 + 这个入口来验证那条路径。
   */
  static async openWith(dataDir: string, status: SecretStoreStatus): Promise<SecretStore> {
    await mkdir(dirname(join(dataDir, "secrets", "x")), { recursive: true });
    return new SecretStore(dataDir, status);
  }

  getStatus(): SecretStoreStatus {
    return this.status;
  }

  /** 写入（覆盖）一条密钥。空字符串等价于删除。 */
  async set(profileId: string, kind: SecretKind, value: string): Promise<void> {
    const ref = refOf(profileId, kind);
    if (!value) {
      await this.remove(profileId, kind);
      return;
    }
    const sealed = await this.seal(profileId, kind, value);
    const path = this.pathFor(ref);
    await writeFile(path, sealed.buffer, { mode: 0o600 });
    await writeFile(`${path}.meta`, JSON.stringify(sealed.meta), { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }

  async has(profileId: string, kind: SecretKind): Promise<boolean> {
    try {
      await readFile(this.pathFor(refOf(profileId, kind)));
      return true;
    } catch {
      return false;
    }
  }

  /** 解密读取。仅用于建立连接或用户显式「查看」。 */
  async get(profileId: string, kind: SecretKind): Promise<string | null> {
    const ref = refOf(profileId, kind);
    const path = this.pathFor(ref);
    const buffer = await readFile(path).catch(() => null);
    if (!buffer) return null;
    const metaRaw = await readFile(`${path}.meta`, "utf8").catch(() => "{}");
    let meta: Record<string, string> = {};
    try {
      meta = JSON.parse(metaRaw) as Record<string, string>;
    } catch {
      meta = {};
    }
    return this.unseal(profileId, kind, buffer, meta).catch(() => null);
  }
  /**
   * 删除一条凭据。
   *
   * ── 必须同时删掉 OS 密钥库里的条目 ────────────────────────────────────────
   * 密钥库后端的密文**不在**那个占位文件里，它躺在 Keychain / libsecret 里。
   * 旧实现只 unlink 了本地文件（以及 .meta），于是用户点了「清除密码」之后，
   * 明文-等价的条目仍留在系统密钥库中：任何人用 `security find-generic-password`
   * 或 `secret-tool lookup` 都还能把它取出来。「清除」必须是真清除。
   *
   * ── 失败必须外抛，且必须留下可以重试的现场 ────────────────────────────────
   * 密钥库删除可能失败（锁屏、权限被拒、`secret-tool` 服务暂时不可用）。此时
   * **不能**吞掉异常，也不能删掉 `.meta`：`.meta` 记着写入时的原始 account，
   * 是唯一能把这条密钥库条目准确定位的线索；删了它，用户下次重试只能靠按当前
   * 档案重算的名字去猜，反而更容易删不掉或删错。所以 `.meta` 永远最后删，
   * 前两步失败时它原封不动，用户可以原样重试。
   *
   * 「条目本来就不存在」不算失败（`security delete-generic-password` 返回
   * exit 44，`secret-tool clear` 在没有任何匹配时静默成功返回 0）：用户要的
   * 是「删完它不在了」，本就不在也算达成，否则重试永远卡在同一条错误上。
   *
   * 账号名优先从 .meta 读（写入时记下的），读不到就按当前档案重算 —— 这样
   * ── 顺序：密钥库 → 本地文件 → .meta ──────────────────────────────────────
   * 先动密钥库：它是「外面的人能不能拿到这条明文」的那一侧，必须最先处理掉。
   *
   * 本地文件其次，且**删不掉就必须外抛** —— dpapi / passphrase-file 后端把密文
   * 就存在那个文件里，留着它等于凭据没删，界面上却说「已清除」就是谎报成功。
   * 此时 `.meta` 刻意保留，用户重试时密钥库那一步会命中「条目不存在」而被当作
   * 成功（见上），于是重试正好只剩下「把本地文件删掉」这一件事。
   *
   * `.meta` 永远最后删、且只保留 ENOENT：前两步任一失败时，它仍在。
   *
   * unlink 只忽略 ENOENT（本来就没有 = 已达目的）；EPERM/EBUSY 之类一律外抛。
   */
  async remove(profileId: string, kind: SecretKind): Promise<void> {
    const path = this.pathFor(refOf(profileId, kind));
    const meta = await this.readMeta(path);
    const account = meta.account || refOf(profileId, kind);
    const backend = meta.backend ?? this.status.backend;

    if (backend === "keychain") {
      await runAllowMissing("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    } else if (backend === "libsecret") {
      await runAllowMissing("secret-tool", ["clear", "service", SERVICE, "account", account]);
    }

    await unlinkAllowMissing(path);
    await unlinkAllowMissing(`${path}.meta`);
  }

  /** 读 .meta（缺省/损坏一律当空对象）。 */
  private async readMeta(path: string): Promise<Record<string, string>> {
    const raw = await readFile(`${path}.meta`, "utf8").catch(() => "{}");
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private pathFor(ref: string): string {
    return join(this.dataDir, "secrets", `${ref}.bin`);
  }

  /**
   * 加密一条凭据。
   *
   * ── OS 密钥库里的「账号名」必须按档案+类型区分 ────────────────────────
   * 旧实现把服务名留空、账号固定成 `pi-terminal`（libsecret 则是固定的
   * `account=default`），于是**所有档案共用同一个条目**：保存第二台主机的密码
   * 会覆盖第一台的，读回来的永远是最新写入的那条。现在两处标识都带上
   * `<profileId>.<kind>`，并且写入与查询用**完全对称**的参数（macOS 的
   * `-s``-a` 两个键值必须一致，否则 find 找不到 add 写的那一条）。
   *
   * 返回的 `buffer` 只对 dpapi / passphrase-file 有意义；密钥库后端把它留空，
   * 真正的密文在 OS 密钥库里。
   */
  private async seal(profileId: string, kind: SecretKind, value: string): Promise<{ buffer: Buffer; meta: Record<string, string> }> {
    if (this.status.backend === "dpapi") {
      const encrypted = await dpapiProtect(Buffer.from(value, "utf8"));
      return { buffer: encrypted, meta: { backend: "dpapi" } };
    }
    if (this.status.backend === "keychain") {
      const account = refOf(profileId, kind);
      // -U 覆盖同名条目；服务名与账号都参与匹配，必须与下面 unseal 的查询一致。
      await runOrThrow("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value]);
      return { buffer: Buffer.alloc(0), meta: { backend: "keychain", account } };
    }
    if (this.status.backend === "libsecret") {
      const account = refOf(profileId, kind);
      await runOrThrow(
        "secret-tool",
        ["store", "--label", `${SERVICE} ${account}`, "service", SERVICE, "account", account],
        value,
      );
      return { buffer: Buffer.alloc(0), meta: { backend: "libsecret", account } };
    }
    // passphrase-file：AES-256-GCM，主密钥保存在同目录（0600）。
    const master = await this.loadMasterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", master, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      buffer: Buffer.concat([iv, tag, ciphertext]),
      meta: { backend: "passphrase-file" },
    };
  }

  private async unseal(profileId: string, kind: SecretKind, buffer: Buffer, meta: Record<string, string>): Promise<string | null> {
    const backend = meta.backend ?? this.status.backend;
    if (backend === "dpapi") {
      const plain = await dpapiUnprotect(buffer);
      return plain.toString("utf8");
    }
    // 账号名从 meta 里取（老数据可能没有，回落到按当前档案重算）。
    const account = meta.account || refOf(profileId, kind);
    if (backend === "keychain") {
      const out = await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]).catch(() => "");
      return out ? out.replace(/\n$/, "") : null;
    }
    if (backend === "libsecret") {
      const out = await run("secret-tool", ["lookup", "service", SERVICE, "account", account]).catch(() => "");
      return out ? out.replace(/\n$/, "") : null;
    }
    if (buffer.length < 28) return null;
    const master = await this.loadMasterKey();
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const ciphertext = buffer.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", master, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  private async loadMasterKey(): Promise<Buffer> {
    const path = join(this.dataDir, "secrets", ".master");
    const existing = await readFile(path).catch(() => null);
    if (existing) return existing;
    const key = randomBytes(32);
    await writeFile(path, key, { mode: 0o600 });
    return key;
  }
}

function refOf(profileId: string, kind: SecretKind): string {
  // profileId 已经是 UUID，但仍做一次白名单校验，防止路径穿越。
  const safe = /^[A-Za-z0-9._-]{1,128}$/.test(profileId) ? profileId : "unknown";
  return `${safe}.${kind}`;
}

async function detectBackend(): Promise<SecretStoreStatus> {
  if (process.platform === "win32") {
    const ok = await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Cryptography.ProtectedData] | Out-Null; 'ok'",
    ]).catch(() => "");
    if (ok.includes("ok")) {
      return { backend: "dpapi", degraded: false, detail: "Windows DPAPI (bound to the current user)" };
    }
    return {
      backend: "passphrase-file",
      degraded: true,
      detail: "DPAPI is unavailable; secrets use a local AES-256-GCM key file (0600)",
    };
  }
  if (process.platform === "darwin") {
    const ok = await run("security", ["-h"]).catch(() => "");
    if (ok) return { backend: "keychain", degraded: false, detail: "macOS Keychain" };
  }
  if (process.platform === "linux") {
    const ok = await run("secret-tool", ["--version"]).catch(() => "");
    if (ok) return { backend: "libsecret", degraded: false, detail: "libsecret (GNOME keyring / KWallet)" };
  }
  return {
    backend: "passphrase-file",
    degraded: true,
    detail: "no OS keystore found; secrets use a local AES-256-GCM key file (0600)",
  };
}

/* ── DPAPI（通过 PowerShell，避免原生模块）────────────────────────────── */

async function dpapiProtect(data: Buffer): Promise<Buffer> {
  // base64 走 stdin/stdout，避免命令行长度与转义问题。
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Security;",
    "$in=[Console]::In.ReadToEnd();",
    "$bytes=[Convert]::FromBase64String($in.Trim());",
    "$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser');",
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join(" ");
  const out = await runOrThrow("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], data.toString("base64"));
  return Buffer.from(out.trim(), "base64");
}

async function dpapiUnprotect(data: Buffer): Promise<Buffer> {
  const script = [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Security;",
    "$in=[Console]::In.ReadToEnd();",
    "$bytes=[Convert]::FromBase64String($in.Trim());",
    "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser');",
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join(" ");
  const out = await runOrThrow("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], data.toString("base64"));
  return Buffer.from(out.trim(), "base64");
}

/* ── 进程封装 ─────────────────────────────────────────────────────────── */

/**
 * 可替换的进程启动器（**仅供测试**）。
 *
 * 密钥库分支在这里就是 `security …` / `secret-tool …` 两条命令。要在 Windows
 * 上验证「删除真的删了密钥库条目」，必须能观察这些 argv —— 真起进程必然 ENOENT。
 * 生产路径永远走默认的 `spawn`。
 */
interface SpawnStream {
  setEncoding: (enc: string) => SpawnStream;
  on: (event: string, listener: (chunk: string) => void) => SpawnStream;
}

interface SpawnHandle {
  stdout: SpawnStream;
  stderr: SpawnStream;
  stdin: { end: (data?: string) => void };
  on: (event: string, listener: (code: number) => void) => void;
}

type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => SpawnHandle;

let spawnImpl: SpawnLike = spawn as unknown as SpawnLike;

/** 仅供测试：注入进程启动器（传 null 恢复默认）。 */
export function __setSpawnForTest(next: SpawnLike | null): void {
  spawnImpl = next ?? (spawn as unknown as SpawnLike);
}
function run(command: string, args: string[], stdin?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnImpl(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || "no stderr"}`));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/**
 * 删除类命令专用：把「本来就不存在」当成成功，其余失败照抛。
 *
 * keychain: `security delete-generic-password` 找不到条目时退出码是 44
 *           （errSecItemNotFound）。
 * libsecret: `secret-tool clear` 在没有匹配项时返回 0，本来就不会进这里。
 */
async function runAllowMissing(command: string, args: string[]): Promise<void> {
  try {
    await run(command, args);
  } catch (error) {
    const text = messageOf(error);
    // exit 44 = macOS 的「没有这个条目」。兼容 `security` 把退出码转写成文本
    // 的情况（以及某些包装层只回传 stderr），所以同时匹配关键字。
    if (/\bexited 44\b/.test(text) || /could not be found in the keychain/i.test(text)) return;
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * unlink，但只把 ENOENT 当成功。
 *
 * `ENOENT` 意味着目标已经不在了 —— 用户要的结果已经达成，重试时也不该报错。
 * 其余错误（Windows 上的 `EPERM`/`EBUSY` 占用、`EACCES` 权限、`EISDIR`）必须
 * 外抛：文件还在，说「已清除」就是谎报成功，而 dpapi / passphrase-file 后端
 * 的密文**就是**在这些文件里，留一份等于凭据没删掉。
 */
async function unlinkAllowMissing(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function runOrThrow(command: string, args: string[], stdin?: string): Promise<string> {
  return run(command, args, stdin);
}

/* ── 常量时间比较（供测试与审计校验使用）───────────────────────────────── */

export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 主密钥派生（仅 passphrase-file 后端使用，保留给未来「导出/导入」能力）。 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}
