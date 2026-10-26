/**
 * 频道路由：视图 → 主进程的**唯一**入站入口。
 *
 * 宿主对自定义通道的转发超时是 30s，因此这里的每个处理器都必须快速返回：
 * 等待类语义（等输出、等连接）不放在这条通道上，而是交给回环流。
 * 例外是 `term.session.open`（SSH 握手可能真的要十几秒），它被显式限制在
 * 20s 内并在超时前返回一个可读的失败。
 *
 * 入参一律当作不可信数据：类型、范围、长度都在这里收口，处理器本身可以
 * 假定输入已经合法。
 */

import type {
  AppSettings,
  Failure,
  SessionSummary,
  SshProfile,
} from "../protocol.js";
import { CHANNELS, MAX_CHUNK_BYTES } from "../protocol.js";
import type { SessionRegistry } from "./sessions.js";
import { normalizeProfileInput } from "./ssh/profiles.js";
import type { ProfileStore } from "./ssh/profiles.js";
import type { SecretStore } from "./ssh/secrets.js";
import type { RelayServer } from "./relay/server.js";
import type { SshTransport } from "./transport/ssh.js";
import { environmentDiagnostics } from "./env.js";
import { DEFAULT_SETTINGS } from "./settings.js";

export interface ChannelDeps {
  registry: SessionRegistry;
  profiles: ProfileStore;
  secrets: SecretStore;
  relay: RelayServer;
  /**
   * 读当前设置。允许返回 Promise 是刻意的：宿主的设置页会随时改值，调用方必须
   * 拿到**此刻**的值，而不是插件启动时的那份快照（见 host/index.ts 的
   * readHostSettings）。
   */
  settings: () => AppSettings | Promise<AppSettings>;

  /** 已安装的字体族（设置里的字体下拉）。只给族名，等宽与否由视图实测。 */
  listFonts: () => Promise<{ families: string[]; monospace: string[] }>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  openSession: (input: { kind: "local" | "ssh"; cols: number; rows: number; profileId?: string; title?: string }) => Promise<SessionSummary>;
  /** 从注册表里取底层 transport（只有文件传输需要）。 */
  transportOf: (sessionId: string) => SshTransport | null;
  /** 首次连接未知主机时向用户提问：视图弹出确认框，等待它的回答。 */
  requestHostKeyDecision: (input: { host: string; port: number; fingerprint: string }) => Promise<boolean>;
  /**
   * 连接自检：不经过会话注册表，因此**不占会话名额**。
   * 返回探测到的指纹，供用户在保存前确认自己连的是哪台机器。
   */
  probeProfile: (profileId: string) => Promise<{ fingerprint: string }>;
  audit: (event: string, detail: Record<string, unknown>) => void;
  /** 版本号用于 ping，便于排障时确认加载的是哪一版。 */
  version: string;
}

type Handler = (payload: Record<string, unknown>) => Promise<unknown>;

export function createChannels(deps: ChannelDeps): (channel: string, payload: unknown) => Promise<unknown> {
  const handlers: Record<string, Handler> = {
    [CHANNELS.ping]: async () => ({
      ok: true,
      version: deps.version,
      sessions: deps.registry.list().length,
      relay: deps.relay.running,
      environment: environmentDiagnostics(),
    }),

    [CHANNELS.sessionsList]: async () => ({ ok: true, sessions: deps.registry.list() }),

    [CHANNELS.sessionOpen]: async (payload) => {
      const kind = payload.kind === "ssh" ? "ssh" : "local";
      const cols = clampInt(payload.cols, 80, 1, 512);
      const rows = clampInt(payload.rows, 24, 1, 256);
      const profileId = optionalString(payload.profileId, 128);
      if (kind === "ssh" && !profileId) return fail("INVALID", "an SSH session needs a connection profile");
      if (kind === "ssh" && profileId && !deps.profiles.get(profileId)) {
        return fail("NOT_FOUND", `no such connection profile: ${profileId}`);
      }
      const title = optionalString(payload.title, 120);
      try {
        const session = await deps.openSession({ kind, cols, rows, profileId, title });
        const info = deps.relay.running ? deps.relay.grant(session.id) : null;
        return { ok: true, session, relay: info };
      } catch (error) {
        return fail(codeOf(error), messageOf(error));
      }
    },

    /**
     * 视图上报「面板当前显示哪个会话」。
     *
     * 这是只读 UI 状态的唯一来源：模型通过 `session action="list"` 的
     * `active` 字段看到它。id 缺失/为空表示没有活动会话（面板关掉了）。
     */
    [CHANNELS.sessionActivate]: async (payload) => {
      const id = optionalString(payload.id, 128);
      deps.registry.setActive(id ?? null);
      return { ok: true, active: deps.registry.activeSessionId };
    },
    [CHANNELS.sessionClose]: async (payload) => {
      const id = requireString(payload.id, "id");
      if (!deps.registry.has(id)) return fail("NOT_FOUND", `no such session: ${id}`);
      await deps.registry.close(id);
      deps.audit("session.close", { sessionId: id });
      return { ok: true };
    },

    [CHANNELS.sessionRename]: async (payload) => {
      const id = requireString(payload.id, "id");
      const title = requireString(payload.title, "title", 120);
      if (!deps.registry.has(id)) return fail("NOT_FOUND", `no such session: ${id}`);
      return { ok: true, session: deps.registry.rename(id, title) };
    },

    /**
     * 重连：沿用原 profile 与尺寸重开一个会话。旧会话必须先由视图关掉
     * （否则会占着 maxSessions 名额），这里只负责「按原样再开一个」。
     */
    [CHANNELS.sessionReconnect]: async (payload) => {
      const id = requireString(payload.id, "id");
      const previous = deps.registry.get(id);
      if (!previous) return fail("NOT_FOUND", `no such session: ${id}`);
      if (previous.kind === "ssh" && !previous.profileId) {
        return fail("INVALID", "this SSH session has no saved profile to reconnect with");
      }
      try {
        const session = await deps.openSession({
          kind: previous.kind,
          cols: previous.cols,
          rows: previous.rows,
          profileId: previous.profileId,
          title: previous.title,
        });
        return { ok: true, session, relay: deps.relay.running ? deps.relay.grant(session.id) : null };
      } catch (error) {
        return fail(codeOf(error), messageOf(error));
      }
    },

    [CHANNELS.input]: async (payload) => {
      const id = requireString(payload.id, "id");
      const raw = requireString(payload.data, "data", MAX_CHUNK_BYTES * 2, true);
      let bytes: Buffer;
      try {
        bytes = Buffer.from(raw, "base64");
      } catch {
        return fail("INVALID", "data must be base64");
      }
      if (bytes.length > MAX_CHUNK_BYTES) return fail("TOO_LARGE", "input chunk is too large");
      try {
        const seq = deps.registry.write(id, bytes);
        return { ok: true, seq };
      } catch (error) {
        return fail(codeOf(error), messageOf(error));
      }
    },

    [CHANNELS.resize]: async (payload) => {
      const id = requireString(payload.id, "id");
      const cols = clampInt(payload.cols, 0, 1, 512);
      const rows = clampInt(payload.rows, 0, 1, 256);
      try {
        deps.registry.resize(id, cols, rows);
        return { ok: true };
      } catch (error) {
        return fail(codeOf(error), messageOf(error));
      }
    },

    /** 兜底读取：回环流不可用时视图降级到这里轮询。 */
    [CHANNELS.read]: async (payload) => {
      const id = requireString(payload.id, "id");
      const fromSeq = clampInt(payload.fromSeq, 1, 1, Number.MAX_SAFE_INTEGER);
      const maxBytes = clampInt(payload.maxBytes, MAX_CHUNK_BYTES, 1024, MAX_CHUNK_BYTES);
      if (!deps.registry.has(id)) return fail("NOT_FOUND", `no such session: ${id}`);
      const read = deps.registry.read(id, fromSeq, maxBytes);
      return { ok: true, ...read };
    },

    [CHANNELS.profileList]: async () => ({ ok: true, profiles: await deps.profiles.list() }),

    [CHANNELS.profileSave]: async (payload) => {
      try {
        // 归一化与模型工具共用一段实现（见 normalizeProfileInput），避免两处
        // 校验各自漂移。面板总是带认证方式提交，非法/缺省按 agent 处理。
        const input = normalizeProfileInput(payload);
        const saved = await deps.profiles.save({ ...input, auth: input.auth ?? "agent" });
        deps.audit("profile.save", {
          profileId: saved.id,
          host: saved.host,
          auth: saved.auth,
          storedPassword: typeof input.password === "string" && input.password.length > 0,
        });
        return { ok: true, profile: saved };
      } catch (error) {
        return fail("INVALID", messageOf(error));
      }
    },

    [CHANNELS.profileDelete]: async (payload) => {
      const id = requireString(payload.id, "id");
      const removed = await deps.profiles.remove(id);
      if (!removed) return fail("NOT_FOUND", `no such connection profile: ${id}`);
      deps.audit("profile.delete", { profileId: id });
      return { ok: true };
    },

    /**
     * 用户点「小眼睛」：按次返回明文。审计是强制的——这条路径是本插件唯一
     * 会把已保存密码重新显示出来的地方。
     */
    [CHANNELS.profileReveal]: async (payload) => {
      const id = requireString(payload.id, "id");
      const kind = payload.kind === "passphrase" ? "passphrase" : "password";
      if (!deps.profiles.get(id)) return fail("NOT_FOUND", `no such connection profile: ${id}`);
      const secret = await deps.profiles.reveal(id, kind);
      deps.audit("profile.reveal", { profileId: id, kind, found: secret !== null });
      if (secret === null) return fail("NOT_FOUND", `no saved ${kind} for this profile`);
      return { ok: true, kind, value: secret, expiresInMs: 5000 };
    },

    /**
     * 连接自检：走完指纹校验 → 认证 → 打开 shell，然后立刻关掉。
     *
     * **不占会话名额**：这是一个一次性的探测，不是用户要用的终端。此前它按普通
     * 会话去开，于是终端开满之后点「测试连接」只会得到「at most N live sessions」
     * —— 一条与 SSH 毫无关系的错误，还会让用户以为主机连不上。
     */
    [CHANNELS.profileTest]: async (payload) => {
      const id = requireString(payload.id, "id");
      const profile = deps.profiles.get(id);
      if (!profile) return fail("NOT_FOUND", `no such connection profile: ${id}`);
      const started = Date.now();
      try {
        const probe = await deps.probeProfile(id);
        deps.audit("profile.test", { profileId: id, host: profile.host, ok: true });
        return {
          ok: true,
          host: profile.host,
          port: profile.port,
          fingerprint: probe.fingerprint,
          elapsedMs: Date.now() - started,
        };
      } catch (error) {
        deps.audit("profile.test", { profileId: id, host: profile.host, ok: false });
        return fail(codeOf(error), messageOf(error));
      }
    },

    /**
     * 一条覆盖**所有活动会话**的令牌。
     *
     * 视图只开一条复用连接（浏览器对同一 host:port 的并发连接上限是 6，
     * 一会话一条长连接时第 7 个终端永远空白），所以令牌也必须覆盖整组会话。
     */
    [CHANNELS.relayMux]: async () => {
      if (!(await deps.settings()).relayEnabled) {
        return fail("UNSUPPORTED", "the loopback relay is disabled in settings");
      }
      const ids = deps.registry
        .list()
        .filter((session) => session.status === "running" || session.status === "starting")
        .map((session) => session.id);
      if (ids.length === 0) return fail("NOT_FOUND", "there is no live session to stream");
      try {
        return { ok: true, ...deps.relay.grantMany(ids) };
      } catch (error) {
        return fail("INTERNAL", messageOf(error));
      }
    },
    [CHANNELS.relayInfo]: async (payload) => {
      const id = requireString(payload.id, "id");
      if (!deps.registry.has(id)) return fail("NOT_FOUND", `no such session: ${id}`);
      if (!(await deps.settings()).relayEnabled) return fail("UNSUPPORTED", "the loopback relay is disabled in settings");
      try {
        return { ok: true, ...deps.relay.grant(id) };
      } catch (error) {
        return fail("INTERNAL", messageOf(error));
      }
    },

    /**
     * 已安装的字体族。
     *
     * 只列族名：等宽与否要看真实渲染宽度，只有视图那边的 canvas 量得出来
     * （见 view/fonts.ts）。枚举本身慢（Windows 要起一次 PowerShell），
     * 所以宿主侧带进程缓存。
     */
    [CHANNELS.fontsList]: async () => ({ ok: true, ...(await deps.listFonts()) }),

    [CHANNELS.settingsGet]: async () => {
      // 每次都重新读：宿主设置页写的是 settings.json，插件侧的缓存不会自己更新。
      const settings = await deps.settings();
      return { ok: true, settings, defaults: DEFAULT_SETTINGS, secretStore: deps.secrets.getStatus() };
    },

    [CHANNELS.settingsSet]: async (payload) => {
      try {
        const patch: Partial<AppSettings> = {};
        const raw = payload.settings;
        if (raw && typeof raw === "object") {
          const input = raw as Record<string, unknown>;
          if (typeof input.defaultShell === "string") patch.defaultShell = input.defaultShell.slice(0, 1024);
          if (input.defaultCwdMode === "workspace" || input.defaultCwdMode === "home") {
            patch.defaultCwdMode = input.defaultCwdMode;
          }
          if (typeof input.scrollback === "number") patch.scrollback = clampInt(input.scrollback, 5000, 100, 50_000);
          if (typeof input.bufferBytes === "number") {
            patch.bufferBytes = clampInt(input.bufferBytes, 2 * 1024 * 1024, 256 * 1024, 8 * 1024 * 1024);
          }
          if (typeof input.maxSessions === "number") patch.maxSessions = clampInt(input.maxSessions, 8, 1, 16);
          if (typeof input.fontSize === "number") patch.fontSize = clampInt(input.fontSize, DEFAULT_SETTINGS.fontSize, 8, 28);
          if (typeof input.fontFamily === "string") patch.fontFamily = input.fontFamily.slice(0, 256);
          if (typeof input.cursorBlink === "boolean") patch.cursorBlink = input.cursorBlink;
          if (typeof input.confirmMultilinePaste === "boolean") {
            patch.confirmMultilinePaste = input.confirmMultilinePaste;
          }
          if (typeof input.relayEnabled === "boolean") patch.relayEnabled = input.relayEnabled;
          if (typeof input.sshKeepaliveSeconds === "number") {
            patch.sshKeepaliveSeconds = clampInt(input.sshKeepaliveSeconds, 20, 5, 300);
          }
        }
        const settings = await deps.updateSettings(patch);
        return { ok: true, settings, defaults: DEFAULT_SETTINGS };
      } catch (error) {
        return fail("INVALID", messageOf(error));
      }
    },

    [CHANNELS.upload]: async (payload) => {
      const id = requireString(payload.id, "id");
      const remotePath = requireString(payload.remotePath, "remotePath", 4096);
      const content = requireString(payload.content, "content", 40 * 1024 * 1024, true);
      const transport = deps.transportOf(id);
      if (!transport) return fail("UNSUPPORTED", "only SSH sessions can upload files");
      const bytes = Buffer.from(content, "base64");
      if (bytes.length > 32 * 1024 * 1024) return fail("TOO_LARGE", "upload is limited to 32 MiB");
      try {
        // 走 ssh2-sftp-client 的 put：面板通道只搬一次内存里的字节，不碰目录语义。
        await transport.withSftp((sftp) => sftp.put(bytes, remotePath));
        deps.audit("session.upload", { sessionId: id, remotePath, bytes: bytes.length });
        return { ok: true, bytes: bytes.length };
      } catch (error) {
        return fail("INTERNAL", messageOf(error));
      }
    },

    [CHANNELS.hostKeyDecision]: async (payload) => {
      const host = requireString(payload.host, "host", 255);
      const port = clampInt(payload.port, 22, 1, 65535);
      const fingerprint = requireString(payload.fingerprint, "fingerprint", 256);
      const accepted = payload.accepted === true;
      deps.audit("hostkey.decision", { host, port, fingerprint, accepted });
      return { ok: true, accepted };
    },
  };

  return async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) return fail("UNSUPPORTED", `unknown channel: ${channel}`);
    const safePayload = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    try {
      return await handler(safePayload);
    } catch (error) {
      return fail(codeOf(error), messageOf(error));
    }
  };
}

/* ── 入参工具 ─────────────────────────────────────────────────────────── */

function requireString(value: unknown, name: string, max = 4096, allowEmpty = false): string {
  if (typeof value !== "string") throw new BadInput(`${name} must be a string`);
  if (!allowEmpty && value.length === 0) throw new BadInput(`${name} must not be empty`);
  if (value.length > max) throw new BadInput(`${name} is longer than ${max} characters`);
  return value;
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

class BadInput extends Error {}

function fail(code: Failure["code"], message: string): Failure {
  return { ok: false, code, message };
}

function codeOf(error: unknown): Failure["code"] {
  const code = (error as { code?: unknown })?.code;
  if (code === "LIMIT" || code === "NOT_FOUND" || code === "INVALID" || code === "AUTH" || code === "HOSTKEY") {
    return code;
  }
  if (error instanceof BadInput) return "INVALID";
  return "INTERNAL";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { SshProfile };
