/**
 * SSH 连接档案：校验、持久化、凭据解析。
 *
 * 持久层只存**非秘密**字段（主机、用户、认证方式、私钥路径等）。密码与
 * 私钥口令走 SecretStore。这个边界是硬性的：`save()` 收到 password 时立刻
 * 交给 SecretStore，绝不写进 profiles.json。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFile as readFileBytes } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { SshProfile } from "../../protocol.js";
import type { SshCredentials } from "../transport/ssh.js";
import type { SecretStore } from "./secrets.js";

const MAX_PROFILES = 64;
const MAX_NAME = 120;
/** 分组名上限：够长表达层级，又不至于把列表挤爆。 */
const MAX_GROUP = 60;

/** 用户提交的档案（可带一次性明文凭据，落盘前会被剥离）。 */
export interface ProfileInput {
  id?: string;
  name?: string;
  /** 分组名；空串等价于「未分组」。 */
  group?: string;
  host?: string;
  port?: number;
  user?: string;
  auth?: SshProfile["auth"];
  privateKeyPath?: string;
  jump?: SshProfile["jump"];
  term?: string;
  initialCommand?: string;
  keepaliveSeconds?: number;
  /** 一次性明文：给出即写入 SecretStore，绝不进 profiles.json。 */
  password?: string;
  passphrase?: string;
  /** 显式清除已保存的密码/口令。 */
  clearPassword?: boolean;
  clearPassphrase?: boolean;
}

export class ProfileStore {
  private profiles: SshProfile[] = [];

  private constructor(
    private readonly dataDir: string,
    private readonly secrets: SecretStore,
  ) {}

  static async open(dataDir: string, secrets: SecretStore): Promise<ProfileStore> {
    const store = new ProfileStore(dataDir, secrets);
    await store.load();
    return store;
  }

  private get path(): string {
    return join(this.dataDir, "profiles.json");
  }

  private async load(): Promise<void> {
    const raw = await readFile(this.path, "utf8").catch(() => "");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      this.profiles = parsed
        .map((entry) => normalizeStoredProfile(entry))
        .filter((entry): entry is SshProfile => entry !== null)
        .slice(0, MAX_PROFILES);
    } catch {
      // 坏文件不阻塞插件启动：保留内存空列表，用户可重新添加。
      this.profiles = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.profiles, null, 2)}\n`, "utf8");
    // Windows 上「rename 覆盖同名文件」会被杀毒/索引服务短暂占用（EPERM/EBUSY），
    // 表现为偶发的「保存档案失败」。重试几次即可，持续失败才向上抛 —— 那种情况
    // 才是真的没权限。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, this.path);
        return;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  /** 视图可见的清单：绝不包含明文，只带 hasPassword/hasPassphrase 标记。 */
  async list(): Promise<SshProfile[]> {
    const out: SshProfile[] = [];
    for (const profile of this.profiles) {
      out.push({
        ...profile,
        hasPassword: await this.secrets.has(profile.id, "password"),
        hasPassphrase: await this.secrets.has(profile.id, "passphrase"),
      });
    }
    return out;
  }

  get(id: string): SshProfile | null {
    return this.profiles.find((profile) => profile.id === id) ?? null;
  }

  async save(input: ProfileInput): Promise<SshProfile> {
    const id = input.id && this.get(input.id) ? input.id : randomUUID();
    const existing = this.get(id);
    const now = Date.now();

    const profile: SshProfile = {
      id,
      name: limit(input.name ?? existing?.name ?? input.host ?? "ssh", MAX_NAME),
      // 分组是可选的自由文本；空串在存储层归一成 undefined（= 未分组），
      // 与 privateKeyPath 一样用 `!== undefined` 区分「没给」与「给了空值」。
      group:
        (input.group !== undefined ? input.group : existing?.group ?? "").trim().slice(0, MAX_GROUP) ||
        undefined,
      host: (input.host ?? existing?.host ?? "").trim(),
      port: clampPort(input.port ?? existing?.port ?? 22),
      user: (input.user ?? existing?.user ?? "").trim(),
      auth: input.auth ?? existing?.auth ?? "agent",
      // 注意不能写成 `input.privateKeyPath ?? existing?.privateKeyPath`：
      // 视图在切到非 key 认证时会显式提交空串表示「清掉它」，而 `??` 会把
      // 空串当作「未提供」从而保留旧路径 —— 界面上看不到、却在下次切回 key
      // 时突然生效。这里用 `!== undefined` 区分「没给」和「给了空值」。
      privateKeyPath:
        (input.privateKeyPath !== undefined ? input.privateKeyPath : existing?.privateKeyPath ?? "").trim() ||
        undefined,
      jump: normalizeJump(input.jump ?? existing?.jump),
      term: (input.term ?? existing?.term ?? "xterm-256color").trim(),
      initialCommand: (input.initialCommand ?? existing?.initialCommand ?? "").trim() || undefined,
      keepaliveSeconds: clampKeepalive(input.keepaliveSeconds ?? existing?.keepaliveSeconds ?? 20),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    validateProfile(profile);

    // 凭据处理：先写入/清除，再持久化非秘密字段。
    if (input.clearPassword) await this.secrets.remove(id, "password");
    if (input.clearPassphrase) await this.secrets.remove(id, "passphrase");
    if (typeof input.password === "string" && input.password.length > 0) {
      await this.secrets.set(id, "password", input.password);
    }
    if (typeof input.passphrase === "string" && input.passphrase.length > 0) {
      await this.secrets.set(id, "passphrase", input.passphrase);
    }

    const index = this.profiles.findIndex((entry) => entry.id === id);
    if (index >= 0) this.profiles[index] = profile;
    else {
      if (this.profiles.length >= MAX_PROFILES) {
        throw new Error(`at most ${MAX_PROFILES} connection profiles are supported`);
      }
      this.profiles.push(profile);
    }
    await this.persist();
    return (await this.list()).find((entry) => entry.id === id) ?? profile;
  }

  /**
   * 删除档案。凭据先删：密钥库删除可能失败（锁屏、权限被拒），那时**档案
   * 必须原样留着** —— 删了档案却删不掉密钥库条目，就等于把「一条还能定位
   * 到密钥库条目的记录」也一并扔掉，用户既看不到它、也没法重试。
   */
  async remove(id: string): Promise<boolean> {
    const index = this.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) return false;
    // 先删凭据，成功了才动内存里的档案表。
    await this.secrets.remove(id, "password");
    await this.secrets.remove(id, "passphrase");
    this.profiles.splice(index, 1);
    await this.persist();
    return true;
  }

  /** 把已保存的秘密解成连接可用的一组凭据。 */
  async credentials(profile: SshProfile, overrides?: { password?: string; passphrase?: string }): Promise<SshCredentials> {
    const credentials: SshCredentials = {};
    const password = overrides?.password || (await this.secrets.get(profile.id, "password"));
    if (password) credentials.password = password;

    const passphrase = overrides?.passphrase || (await this.secrets.get(profile.id, "passphrase"));
    if (passphrase) credentials.passphrase = passphrase;

    if (profile.auth === "key" && profile.privateKeyPath) {
      credentials.privateKey = await readPrivateKey(profile.privateKeyPath);
    }
    return credentials;
  }

  /** 用户点「小眼睛」时的按次明文返回。 */
  async reveal(id: string, kind: "password" | "passphrase"): Promise<string | null> {
    return this.secrets.get(id, kind);
  }
}

async function readPrivateKey(configuredPath: string): Promise<Buffer> {
  const path = expandHome(configuredPath);
  if (!isAbsolute(path)) {
    throw new Error(`private key path must be absolute: ${configuredPath}`);
  }
  try {
    return await readFileBytes(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the private key at ${path}: ${detail}`);
  }
}

export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function validateProfile(profile: SshProfile): void {
  if (!profile.host) throw new Error("host is required");
  // 只接受主机名/IP：出现协议前缀通常是用户把 URL 粘进来了。
  if (/^[a-z+]+:\/\//i.test(profile.host)) {
    throw new Error("host must be a hostname or IP address, not a URL");
  }
  if (!/^[A-Za-z0-9._:\-[\]]+$/.test(profile.host)) {
    throw new Error(`host contains unexpected characters: ${profile.host}`);
  }
  if (!profile.user) throw new Error("user is required");
  if (!/^[A-Za-z0-9._@\-\\]+$/.test(profile.user)) {
    throw new Error(`user contains unexpected characters: ${profile.user}`);
  }
  if (profile.auth === "key" && !profile.privateKeyPath) {
    throw new Error("a key-based profile needs a private key path");
  }
  for (const hop of profile.jump ?? []) {
    if (!hop.host || !hop.user) throw new Error("every jump host needs a host and a user");
  }
}

function normalizeStoredProfile(value: unknown): SshProfile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SshProfile>;
  if (!raw.id || !raw.host || !raw.user) return null;
  return {
    id: String(raw.id),
    name: limit(String(raw.name ?? raw.host), MAX_NAME),
    group: raw.group ? String(raw.group).trim().slice(0, MAX_GROUP) || undefined : undefined,
    host: String(raw.host),
    port: clampPort(raw.port),
    user: String(raw.user),
    auth: raw.auth === "key" || raw.auth === "password" ? raw.auth : "agent",
    privateKeyPath: raw.privateKeyPath ? String(raw.privateKeyPath) : undefined,
    jump: normalizeJump(raw.jump),
    term: raw.term ? String(raw.term) : "xterm-256color",
    initialCommand: raw.initialCommand ? String(raw.initialCommand) : undefined,
    keepaliveSeconds: clampKeepalive(raw.keepaliveSeconds),
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
  };
}

function normalizeJump(jump: SshProfile["jump"] | undefined): SshProfile["jump"] {
  if (!Array.isArray(jump)) return undefined;
  const hops: NonNullable<SshProfile["jump"]> = jump
    .filter((hop) => hop && typeof hop.host === "string" && typeof hop.user === "string" && hop.host && hop.user)
    .slice(0, 4)
    .map((hop) => ({
      host: hop.host,
      port: clampPort(hop.port),
      user: hop.user,
      auth: (hop.auth === "key" || hop.auth === "password" ? hop.auth : "agent") as SshProfile["auth"],
    }));
  return hops.length > 0 ? hops : undefined;
}

function clampPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isFinite(port)) return 22;
  return Math.min(65535, Math.max(1, Math.round(port)));
}

function clampKeepalive(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 20;
  return Math.min(300, Math.max(5, Math.round(seconds)));
}

function limit(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
/**
 * 把「外部提交的档案」归一化成 ProfileInput。
 *
 * 面板与模型工具共用同一段逻辑：两处各写一份校验，迟早会出现「面板能存、
 * 工具存进去的却是另一种形状」。这里只做**归一化**（截断、去空白、类型收窄），
 * 必填校验仍由 `ProfileStore.save` 的 `validateProfile` 负责。
 *
 * 注意 `auth`：非法值返回 `undefined`（= 保持原值），而不是强行写成 "agent"；
 * 面板那边需要默认值时由调用点补 `?? "agent"`。
 */
export function normalizeProfileInput(raw: unknown): ProfileInput {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  };
  const auth = input.auth === "key" || input.auth === "password" || input.auth === "agent" ? input.auth : undefined;
  return {
    id: text(input.id, 128),
    name: text(input.name, MAX_NAME),
    // 空串是**有意义的输入**（把主机移出分组），所以不用 text()。
    group: typeof input.group === "string" ? input.group.trim().slice(0, MAX_GROUP) : undefined,
    host: text(input.host, 255),
    port: typeof input.port === "number" && Number.isFinite(input.port) ? input.port : undefined,
    user: text(input.user, 128),
    auth,
    // 同上：空串表示「清掉现有私钥路径」。
    privateKeyPath: typeof input.privateKeyPath === "string" ? input.privateKeyPath.trim().slice(0, 1024) : undefined,
    jump: Array.isArray(input.jump) ? (input.jump as ProfileInput["jump"]) : undefined,
    term: text(input.term, 64),
    initialCommand: text(input.initialCommand, 512),
    keepaliveSeconds:
      typeof input.keepaliveSeconds === "number" && Number.isFinite(input.keepaliveSeconds)
        ? input.keepaliveSeconds
        : undefined,
    password: typeof input.password === "string" ? input.password : undefined,
    passphrase: typeof input.passphrase === "string" ? input.passphrase : undefined,
    clearPassword: input.clearPassword === true,
    clearPassphrase: input.clearPassphrase === true,
  };
}
