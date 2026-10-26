/**
 * 模型工具实现（v1.0.0：按对象聚合，名字不带前缀）。
 *
 * 工具面共 8 个，全部用短名：read / send / wait / upload / download / session /
 * profile / setting（session/profile/setting 用 `action` 分派）。宿主注册时会自己
 * 加上 `plugin_local_pi_terminal_` 前缀，所以这里再写 `terminal_` 就是同义反复。
 * 四条硬规则：
 *   1. **读取一律脱敏**：模型看到的是 `redactSecrets` 之后的内容，用户自己看终端
 *      永远是原始字节；工具输出不额外落盘。
 *   2. **写入必须留痕**：任何改变用户机器的动作都写审计（谁、哪个对象、多少字节），
 *      但不记录内容本身（内容里可能就是密码）。
 *   3. **错误是数据而不是异常**：返回 `{ok:false, code, message}`，让模型自己纠错
 *      （换 sessionId、先 list、缩短等待），而不是中断整轮。
 *   4. **索引参数不许缺省成「全部」**：省略 sessionId / profileId / key 一律拒绝。
 *      批量重置设置必须显式 `key="*"`。一次漏参的调用绝不能变成批量修改或批量关闭。
 */

import type { SessionRegistry } from "../sessions.js";
import type { ProfileStore } from "../ssh/profiles.js";
import { MAX_READ_BYTES, MAX_READ_LINES } from "../../protocol.js";
import type { AppSettings, Failure, SessionSummary, SshProfile } from "../../protocol.js";
import { coerceSettingsPatch, SETTINGS_KEYS } from "../settings.js";
import { TOOL_DECLARATIONS } from "./declarations.js";
import type { ToolDeclaration } from "./declarations.js";
import type { DownloadRequest, TransferOutcome, UploadRequest } from "../ssh/sftp.js";

export interface ToolContext {
  registry: SessionRegistry;
  profiles: ProfileStore;
  audit: (event: string, detail: Record<string, unknown>) => void;
  /**
   * 上传到某个 SSH 会话的远端；本地会话返回 null。
   *
   * 具体走 ssh2-sftp-client 的哪条 API（put / fastPut / uploadDir）由实现决定，
   * 工具层只声明「要传什么、要不要流式」，不重复一套文件遍历与重试逻辑。
   */
  uploadToSession?: (sessionId: string, request: UploadRequest) => Promise<TransferOutcome | null>;
  /** 从某个 SSH 会话的远端下载；本地会话返回 null。 */
  downloadFromSession?: (sessionId: string, request: DownloadRequest) => Promise<TransferOutcome | null>;
  /** 新建会话需要走注册表，注册表再回调工厂；这里只暴露一个受限入口。 */
  openSession: (input: {
    kind: "local" | "ssh";
    profileId?: string;
    cwd?: string;
    /** 仅本地：命令名或绝对路径；缺省用设置里的默认 shell。 */
    shell?: string;
    title?: string;
  }) => Promise<{ id: string }>;
  /**
   * 设置读写。
   *
   * 工具不自己碰 settings.json：真源与夹取规则都在宿主侧（见 settings.ts），
   * 这里只负责「校验模型给的补丁」再转交，避免出现第二套默认值。
   */
  settings: {
    read: () => Promise<AppSettings>;
    defaults: AppSettings;
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
    reset: (keys?: string[]) => Promise<AppSettings>;
  };
  /** 档案增删：与面板共用 normalizeProfileInput / ProfileStore。 */
  saveProfile: (input: Record<string, unknown>) => Promise<SshProfile>;
  deleteProfile: (id: string) => Promise<boolean>;
  /**
   * 连接自检：探一次「指纹 → 认证 → shell」然后立刻断开。
   * **不是会话**，因此不占会话名额 —— 直接对接 factory.probeSshProfile。
   */
  probeProfile: (profileId: string) => Promise<{ fingerprint: string }>;
}

type ToolResult = Record<string, unknown>;

interface ToolDefinition {
  declaration: ToolDeclaration;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** 合法 base64：只允许标准字母表，允许换行（模型常按行折行）。 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * 下载内容「内联回传」的上限。
 *
 * 工具结果会被塞进模型上下文，不是磁盘：默认 256 KiB 足够看一个源码或配置文件，
 * 硬上限 1 MiB 兜住「不小心中转了一个二进制」。再大就该落盘（localPath）。
 */
const INLINE_DOWNLOAD_BYTES = 256 * 1024;
const MAX_INLINE_DOWNLOAD_BYTES = 1024 * 1024;

export function buildTools(context: ToolContext): ToolDefinition[] {
  const { registry, profiles, audit, openSession } = context;
  const settingsStore = context.settings;
  const uploadToSession = context.uploadToSession;
  const downloadFromSession = context.downloadFromSession;

  return [
    readTool(),
    sendTool(),
    waitTool(),
    uploadTool(),
    downloadTool(),
    sessionTool(),
    profileTool(),
    settingTool(),
  ];

  /* ── read ───────────────────────────────────────────────────────────── */

  function readTool(): ToolDefinition {
    return {
      declaration: findDeclaration("read"),
      execute: async (args) => {
        const sessionId = text(args.sessionId);
        if (!sessionId) return missingIndex("sessionId", "read");
        if (!registry.has(sessionId)) return notFoundSession(sessionId);

        const summary = registry.get(sessionId);
        const maxLines = clampNumber(args.maxLines, 200, 1, MAX_READ_LINES);
        const fromSeq =
          typeof args.fromSeq === "number" && Number.isFinite(args.fromSeq)
            ? Math.max(1, Math.floor(args.fromSeq))
            : // 没给起点时读「最近一屏」，而不是从缓冲区最早处开始。
              Math.max(1, (summary?.seq ?? 1) - maxLines);

        const read = registry.readText(sessionId, fromSeq, MAX_READ_BYTES, maxLines);
        return {
          ok: true,
          sessionId,
          text: read.text,
          nextSeq: read.nextSeq,
          // truncated 只表示「起点已经被环形缓冲丢掉」，不表示这次被 maxLines 截断。
          truncated: read.truncated,
          redactions: read.redactions,
          more: summary ? read.nextSeq <= summary.seq : false,
          note: read.truncated
            ? "The requested start is older than the retained buffer; text may begin mid-output."
            : undefined,
        };
      },
    };
  }

  /* ── send ───────────────────────────────────────────────────────────── */

  function sendTool(): ToolDefinition {
    return {
      declaration: findDeclaration("send"),
      execute: async (args) => {
        const sessionId = text(args.sessionId);
        if (!sessionId) return missingIndex("sessionId", "send");
        if (typeof args.text !== "string") return fail("INVALID", 'send needs "text" (a string; may be empty to just press Enter)');
        if (!registry.has(sessionId)) return notFoundSession(sessionId);

        const enter = args.enter !== false;
        const waitMs = clampNumber(args.waitMs, 2500, 0, 20_000);

        const status = registry.get(sessionId)?.status;
        if (status !== "running") {
          return fail(
            "INVALID",
            `session is ${status ?? "unknown"}; it cannot accept input. Open a new session or reconnect first.`,
          );
        }

        const before = registry.latestSeq(sessionId);
        // 回车必须是 CR：
        //   · Windows 的 ConPTY/PSReadLine 只把 `\r` 当 Enter，裸 `\n` 只被当作
        //     普通换行字符 —— 补上后光标停在行尾、命令不执行（这正是曾经的现象）；
        //   · POSIX 终端的 ICRNL 同样把 `\r` 映射成回车。
        // 因此文本里的换行也一并归一成 `\r`：「一个换行 = 按一次 Enter」。
        const typed = toTerminalInput(args.text);
        const payload = enter ? `${typed}\r` : typed;
        registry.write(sessionId, Buffer.from(payload, "utf8"));
        audit("tool.send", { sessionId, bytes: Buffer.byteLength(payload), enter });

        if (waitMs > 0) {
          // 静默窗口取 min(800, waitMs)：多数命令几百毫秒就没输出了，不该干等满 waitMs。
          await registry.waitForIdle(sessionId, Math.min(800, waitMs), waitMs);
        }
        const read = registry.readText(sessionId, before + 1, MAX_READ_BYTES, MAX_READ_LINES);
        return {
          ok: true,
          sessionId,
          wroteBytes: Buffer.byteLength(payload),
          output: read.text,
          nextSeq: read.nextSeq,
          redactions: read.redactions,
        };
      },
    };
  }

  /* ── wait ───────────────────────────────────────────────────────────── */

  function waitTool(): ToolDefinition {
    return {
      declaration: findDeclaration("wait"),
      execute: async (args) => {
        const sessionId = text(args.sessionId);
        if (!sessionId) return missingIndex("sessionId", "wait");
        if (!registry.has(sessionId)) return notFoundSession(sessionId);

        const quietMs = clampNumber(args.quietMs, 1200, 100, 10_000);
        const timeoutMs = clampNumber(args.timeoutMs, 15_000, 100, 60_000);
        const fromSeq =
          typeof args.fromSeq === "number" && Number.isFinite(args.fromSeq)
            ? Math.max(1, Math.floor(args.fromSeq))
            : registry.latestSeq(sessionId) + 1;

        const waited = await registry.waitForIdle(sessionId, quietMs, timeoutMs);
        const read = registry.readText(sessionId, fromSeq, MAX_READ_BYTES, MAX_READ_LINES);
        return {
          ok: true,
          sessionId,
          quiet: waited.quiet,
          timedOut: !waited.quiet,
          output: read.text,
          nextSeq: read.nextSeq,
          redactions: read.redactions,
        };
      },
    };
  }

  /* ── upload ─────────────────────────────────────────────────────────── */

  /**
   * 上传：三种形态由参数决定，而不是三个工具。
   *   content  → 内联文本/二进制（sftp.put(buffer)）
   *   localPath 是文件 → fastPut / put(readable)
   *   localPath 是目录 → uploadDir（useFastput = !stream）
   * 形态判定放在实现里（它要 stat 本机文件），工具层只做参数互斥校验。
   */
  function uploadTool(): ToolDefinition {
    return {
      declaration: findDeclaration("upload"),
      execute: async (args) => {
        const sessionId = text(args.sessionId);
        if (!sessionId) return missingIndex("sessionId", "upload");
        const remotePath = text(args.remotePath);
        if (!remotePath) return missingIndex("remotePath", "upload");
        if (!registry.has(sessionId)) return notFoundSession(sessionId);
        if (!remotePath.startsWith("/")) {
          return fail(
            "INVALID",
            "remotePath must be absolute (start with /) so it cannot be resolved against an unknown cwd",
          );
        }

        const hasContent = typeof args.content === "string";
        const localPath = text(args.localPath);
        if (hasContent && localPath) {
          return fail(
            "INVALID",
            'pass either "content" (inline) or "localPath" (a file or folder on this machine), never both',
          );
        }
        if (!hasContent && !localPath) {
          return fail(
            "INVALID",
            'upload needs "content" (inline text/base64) or "localPath" (a local file or folder)',
          );
        }

        let content: Buffer | undefined;
        if (hasContent) {
          const decoded = decodeContent(args.content as string, args.encoding);
          if ("error" in decoded) return decoded.error;
          if (decoded.bytes.length > MAX_UPLOAD_BYTES) {
            return fail("TOO_LARGE", `content is ${decoded.bytes.length} bytes; the limit is ${MAX_UPLOAD_BYTES}`);
          }
          content = decoded.bytes;
        }

        const stream = args.stream === true;
        const mode = parseMode(args.mode);
        // SFTP 的错误（无权限、父目录不存在、磁盘满、连接已断）必须变成数据，
        // 而不是一个没有 code 的异常冒到宿主。
        let outcome: TransferOutcome | null = null;
        try {
          outcome =
            (await uploadToSession?.(sessionId, {
              remotePath,
              content,
              localPath: localPath || undefined,
              mode,
              stream,
            })) ?? null;
        } catch (error) {
          return fail(transferFailureCodeOf(error), messageOf(error));
        }
        if (!outcome) {
          return fail("UNSUPPORTED", "session is not an SSH session (only SSH sessions have a remote filesystem)");
        }

        audit("tool.upload", {
          sessionId,
          remotePath,
          kind: outcome.kind,
          bytes: outcome.bytes ?? 0,
          entries: outcome.entries,
          stream,
        });
        return {
          ok: true,
          sessionId,
          remotePath,
          kind: outcome.kind,
          bytes: outcome.bytes,
          entries: outcome.entries,
          mode: mode.toString(8),
          stream,
          transport: outcome.transport,
        };
      },
    };
  }

  /* ── download ───────────────────────────────────────────────────────── */

  /**
   * 下载：给了 localPath 就落盘（文件 fastGet / get(writable)，目录 downloadDir），
   * 没给就把**小文件**的内容直接回传 —— 模型最常要的其实是「看一眼这个文件」，
   * 让它先下载到磁盘再去读，多一步还多一份垃圾文件。
   */
  function downloadTool(): ToolDefinition {
    return {
      declaration: findDeclaration("download"),
      execute: async (args) => {
        const sessionId = text(args.sessionId);
        if (!sessionId) return missingIndex("sessionId", "download");
        const remotePath = text(args.remotePath);
        if (!remotePath) return missingIndex("remotePath", "download");
        if (!registry.has(sessionId)) return notFoundSession(sessionId);
        if (!remotePath.startsWith("/")) {
          return fail(
            "INVALID",
            "remotePath must be absolute (start with /) so it cannot be resolved against an unknown cwd",
          );
        }

        const localPath = text(args.localPath);
        const stream = args.stream === true;
        const maxBytes = clampNumber(args.maxBytes, INLINE_DOWNLOAD_BYTES, 1, MAX_INLINE_DOWNLOAD_BYTES);

        let outcome: TransferOutcome | null = null;
        try {
          outcome =
            (await downloadFromSession?.(sessionId, {
              remotePath,
              localPath: localPath || undefined,
              stream,
              maxBytes,
            })) ?? null;
        } catch (error) {
          return fail(transferFailureCodeOf(error), messageOf(error));
        }
        if (!outcome) {
          return fail("UNSUPPORTED", "session is not an SSH session (only SSH sessions have a remote filesystem)");
        }

        audit("tool.download", {
          sessionId,
          remotePath,
          kind: outcome.kind,
          bytes: outcome.bytes ?? 0,
          stream,
          localPath: localPath || undefined,
        });
        const result: ToolResult = {
          ok: true,
          sessionId,
          remotePath,
          kind: outcome.kind,
          localPath: localPath || undefined,
          bytes: outcome.bytes,
          stream,
          transport: outcome.transport,
        };
        if (outcome.content) {
          const encoded = encodeContent(outcome.content, args.encoding);
          result.encoding = encoded.encoding;
          result.content = encoded.text;
          if (encoded.note) result.note = encoded.note;
        }
        return result;
      },
    };
  }

  /* ── session ────────────────────────────────────────────────────────── */

  function sessionTool(): ToolDefinition {
    return {
      declaration: findDeclaration("session"),
      execute: async (args) => {
        const action = actionOf(args);

        if (action === "list") {
          return { ok: true, sessions: registry.list().map(summarizeSession), live: registry.liveCount() };
        }

        if (action === "close") {
          const sessionId = text(args.sessionId);
          if (!sessionId) {
            return fail(
              "INVALID",
              'action="close" needs "sessionId". Pass one id, or sessionId="*" to close every session explicitly.',
            );
          }
          // "*" 是**显式**的批量：省略参数仍然被拒绝，只有写出星号才会关闭全部。
          if (sessionId === "*") {
            // ids() 含「正在建立中」的条目：漏掉它们会让「关闭全部」之后又冒出新标签。
            const ids = registry.ids();
            for (const id of ids) await registry.close(id).catch(() => undefined);
            audit("tool.session.closeAll", { count: ids.length });
            return { ok: true, sessionId: "*", closed: ids.length, sessionIds: ids };
          }
          if (!registry.has(sessionId)) return notFoundSession(sessionId);
          await registry.close(sessionId);
          audit("tool.session.close", { sessionId });
          return { ok: true, sessionId, closed: true };
        }

        if (action === "create") {
          const kind = args.kind === "ssh" ? "ssh" : "local";
          const profileId = text(args.profileId);
          const cwd = text(args.cwd);
          const shell = text(args.shell);
          const title = text(args.title) || undefined;

          if (kind === "ssh" && !profileId) {
            return fail("INVALID", 'kind="ssh" needs "profileId" (see profile action="list")');
          }
          if (kind === "local" && profileId) {
            return fail("INVALID", '"profileId" only applies to kind="ssh"');
          }
          if (kind === "ssh" && (cwd || shell)) {
            return fail("INVALID", '"cwd" and "shell" only apply to kind="local"; the remote side decides both');
          }
          // shell 只接受「命令名」或「绝对路径」，不接受带参数的一整行：拆分命令行引号
          // 是另一个雷区，而且会让审计日志里出现半条命令。
          if (shell && /\s/.test(shell) && !/^[A-Za-z]:[\\/]/.test(shell) && !shell.startsWith("/") && !shell.startsWith("\\\\")) {
            return fail(
              "INVALID",
              `shell must be a command name or an absolute path, without arguments: ${shell}`,
            );
          }
          if (profileId && !profiles.get(profileId)) return notFoundProfile(profileId);
          if (registry.liveCount() >= registry.maxSessions) {
            return fail("LIMIT", `at most ${registry.maxSessions} live sessions are allowed; close one first`);
          }

          try {
            const opened = await openSession({
              kind,
              profileId: kind === "ssh" ? profileId : undefined,
              cwd: kind === "local" ? cwd || undefined : undefined,
              shell: kind === "local" ? shell || undefined : undefined,
              title,
            });
            audit("tool.session.create", { sessionId: opened.id, kind, profileId, cwd, shell });
            return {
              ok: true,
              sessionId: opened.id,
              kind,
              cwd: kind === "local" ? cwd || undefined : undefined,
              shell: kind === "local" ? shell || undefined : undefined,
            };
          } catch (error) {
            return fail(failureCodeOf(error), messageOf(error));
          }
        }

        return fail("INVALID", `unknown action "${action || "(missing)"}"; expected list, create or close`);
      },
    };
  }

  /* ── profile ────────────────────────────────────────────────────────── */

  function profileTool(): ToolDefinition {
    return {
      declaration: findDeclaration("profile"),
      execute: async (args) => {
        const action = actionOf(args);

        if (action === "list") {
          return { ok: true, profiles: (await profiles.list()).map(summarizeProfile) };
        }

        if (action === "delete" || action === "test") {
          const profileId = text(args.profileId);
          if (!profileId) return missingIndex("profileId", `profile action="${action}"`);
          if (profileId === "*") return fail("INVALID", `action="${action}" does not accept "*"; pass one profileId`);
          const profile = profiles.get(profileId);
          if (!profile) return notFoundProfile(profileId);

          if (action === "delete") {
            const removed = await context.deleteProfile(profileId);
            if (!removed) return notFoundProfile(profileId);
            audit("tool.profile.delete", { profileId });
            return { ok: true, profileId, deleted: true };
          }

          const started = Date.now();
          try {
            // 自检**不是会话**：走 probeProfile，不占会话名额、不进标签栏。
            // 曾经这里开一个临时会话来测，于是「终端开满 8 个」时自检会失败并
            // 报出一条与 SSH 无关的 LIMIT —— 和面板里的连接测试是同一个坑。
            const probe = await context.probeProfile(profileId);
            const elapsedMs = Date.now() - started;
            audit("tool.profile.test", { profileId, host: profile.host, ok: true, elapsedMs });
            return { ok: true, profileId, host: profile.host, port: profile.port, elapsedMs, fingerprint: probe.fingerprint };
          } catch (error) {
            audit("tool.profile.test", { profileId, host: profile.host, ok: false });
            return fail(failureCodeOf(error), messageOf(error));
          }
        }

        if (action === "create" || action === "update") {
          // 凭据不进模型通道：它会被写进对话记录，而对话记录不是密钥库。
          if (args.password !== undefined || args.passphrase !== undefined) {
            return fail(
              "INVALID",
              "passwords and key passphrases are not accepted through tools; ask the user to enter them in the panel",
            );
          }
          const profileId = text(args.profileId);
          if (profileId === "*") return fail("INVALID", 'profileId does not accept "*"');
          if (action === "update" && !profileId) return missingIndex("profileId", 'profile action="update"');
          if (action === "create" && profileId) {
            return fail("INVALID", 'action="create" must not carry profileId; use action="update" to change an existing one');
          }
          if (action === "update" && !profiles.get(profileId)) return notFoundProfile(profileId);

          try {
            const { profileId: _ignored, action: _action, ...fields } = args;
            const saved = await context.saveProfile(profileId ? { ...fields, id: profileId } : fields);
            audit("tool.profile.save", { profileId: saved.id, host: saved.host, auth: saved.auth, created: action === "create" });
            return { ok: true, created: action === "create", profile: summarizeProfile(saved) };
          } catch (error) {
            return fail("INVALID", messageOf(error));
          }
        }

        return fail("INVALID", `unknown action "${action || "(missing)"}"; expected list, create, update, delete or test`);
      },
    };
  }

  /* ── setting ────────────────────────────────────────────────────────── */

  function settingTool(): ToolDefinition {
    return {
      declaration: findDeclaration("setting"),
      execute: async (args) => {
        const action = actionOf(args);
        const defaults = settingsStore.defaults as unknown as Record<string, unknown>;

        if (action === "list") {
          return {
            ok: true,
            settings: await settingsStore.read(),
            defaults: settingsStore.defaults,
            keys: [...SETTINGS_KEYS],
          };
        }

        if (action === "get") {
          const key = text(args.key);
          if (!key) return missingIndex("key", 'setting action="get"');
          if (key === "*") return fail("INVALID", 'action="get" does not accept "*"; pass one key (or use action="list")');
          if (!isSettingKey(key)) return unknownSetting(key);
          const settings = await settingsStore.read() as unknown as Record<string, unknown>;
          return { ok: true, key, value: settings[key], default: defaults[key] };
        }

        if (action === "update") {
          if (args.settings === undefined) {
            return fail("INVALID", 'action="update" needs "settings": an object such as { "fontSize": 14 }');
          }
          const { patch, problems } = coerceSettingsPatch(args.settings);
          if (problems.length > 0) return fail("INVALID", problems.join("; "), { problems });
          const keys = Object.keys(patch);
          if (keys.length === 0) return fail("INVALID", '"settings" is empty; nothing to change');
          try {
            const settings = await settingsStore.update(patch);
            audit("tool.setting.update", { keys });
            // 回传「生效值」而不是「请求值」：越界会被夹取，模型要看见真正的结果。
            return { ok: true, changed: keys, settings };
          } catch (error) {
            return fail("INTERNAL", messageOf(error));
          }
        }

        if (action === "reset") {
          const raw = args.key;
          if (typeof raw !== "string" || !raw.trim()) {
            return fail(
              "INVALID",
              'action="reset" needs "key". To reset every setting pass key="*" explicitly — an omitted key never means "all".',
            );
          }
          const key = raw.trim();
          if (key === "*") {
            const settings = await settingsStore.reset();
            audit("tool.setting.reset", { keys: "all" });
            return { ok: true, reset: "all", keys: [...SETTINGS_KEYS], settings };
          }
          if (!isSettingKey(key)) return unknownSetting(key);
          try {
            const settings = await settingsStore.reset([key]);
            audit("tool.setting.reset", { keys: [key] });
            return { ok: true, reset: key, settings };
          } catch (error) {
            return fail("INTERNAL", messageOf(error));
          }
        }

        return fail("INVALID", `unknown action "${action || "(missing)"}"; expected list, get, update or reset`);
      },
    };
  }
}

/* ── 辅助 ─────────────────────────────────────────────────────────────── */

function findDeclaration(name: string): ToolDeclaration {
  // 声明与实现同源：这里找不到说明代码与清单已经漂移，必须立刻失败。
  const found = TOOL_DECLARATIONS.find((item) => item.name === name);
  if (!found) throw new Error(`tool declaration missing: ${name}`);
  return found;
}

function fail(code: Failure["code"], message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { ok: false, code, message, ...extra };
}

/**
 * 必填「索引参数」缺失。
 *
 * 这条提示刻意把规则讲清楚：省略不等于「全部」，改用具体的 id，批量重置要 key="*"。
 * 模型读到它就知道该补什么，而不是再猜一次。
 */
function missingIndex(name: string, usage: string): ToolResult {
  const hint = name === "key" ? ' To act on every setting pass key="*" explicitly.' : "";
  return fail(
    "INVALID",
    `${usage}: "${name}" is required. An omitted index parameter never means "all items", so the call was refused.${hint}`,
  );
}

function unknownSetting(key: string): ToolResult {
  return fail("INVALID", `unknown setting: ${key} (allowed: ${SETTINGS_KEYS.join(", ")}, or "*" with action="reset")`);
}

function isSettingKey(key: string): boolean {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

function notFoundSession(sessionId: string): ToolResult {
  return fail(
    "NOT_FOUND",
    `no such session: ${sessionId}. Call session action="list" to see the live ones.`,
  );
}

function notFoundProfile(profileId: string): ToolResult {
  return fail(
    "NOT_FOUND",
    `no such connection profile: ${profileId}. Call profile action="list" to see the saved ones.`,
  );
}

function summarizeSession(session: SessionSummary): Record<string, unknown> {
  return {
    id: session.id,
    kind: session.kind,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    seq: session.seq,
    message: session.message,
    /** 面板当前显示的就是这个会话（由视图上报，不是「最近创建」）。 */
    active: session.active === true,
  };
}

function summarizeProfile(profile: SshProfile): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name,
    group: profile.group,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    auth: profile.auth,
    privateKeyPath: profile.privateKeyPath,
    jumpHosts: (profile.jump ?? []).length,
    hasPassword: profile.hasPassword === true,
    hasPassphrase: profile.hasPassphrase === true,
  };
}

function actionOf(args: Record<string, unknown>): string {
  return typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
}

/** 归一化字符串参数：非字符串/空白一律当「没给」。 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function parseMode(value: unknown): number {
  if (typeof value !== "string" || !/^[0-7]{3,4}$/.test(value)) return 0o644;
  return Number.parseInt(value, 8);
}

/** 把 SSH 失败映射成固定的错误码，模型可以据此决定「改配置」还是「换网络」。 */
function failureCodeOf(error: unknown): Failure["code"] {
  const message = messageOf(error);
  if (/host key|fingerprint/i.test(message)) return "HOSTKEY";
  if (/auth|password|permission denied|no supported authentication/i.test(message)) return "AUTH";
  // 调用方给的参数不成立（shell 不存在、cwd 不存在/不是绝对路径）—— 换参数就能成功。
  if (/not found on PATH|does not exist|must be an absolute path|is not an existing directory|without arguments/i.test(message)) {
    return "INVALID";
  }
  return "INTERNAL";
}

/**
 * 传输失败的原因比握手更具体：权限/路径类问题要能被模型识别并换参数重试。
 * ssh2-sftp-client 会把 sftp 的数值错误码和文本一起抛出来，这里按文本归类。
 */
function transferFailureCodeOf(error: unknown): Failure["code"] {
  const message = messageOf(error);
  if (/permission denied|EACCES|EPERM/i.test(message)) return "AUTH";
  if (/no such file|ENOENT|not a directory|ENOTDIR|does not exist|bad path|failure/i.test(message)) {
    return "INVALID";
  }
  if (/inline limit/i.test(message)) return "TOO_LARGE";
  return "INTERNAL";
}

/**
 * 内联内容 → 字节。
 *
 * utf8 是默认；base64 用于二进制，并且**先校验再解码**：`Buffer.from(x, "base64")`
 * 对垃圾输入会静默产出空串或半截数据，那比报错更糟 —— 远端会得到一个空文件。
 */
function decodeContent(value: string, encoding: unknown): { bytes: Buffer } | { error: ToolResult } {
  if (encoding !== "base64") return { bytes: Buffer.from(value, "utf8") };
  const cleaned = value.replace(/\s+/g, "");
  if (!BASE64_PATTERN.test(cleaned) || cleaned.length % 4 !== 0) {
    return {
      error: fail(
        "INVALID",
        'content is not valid base64. Pass plain text with encoding="utf8", or real base64 for binary files.',
      ),
    };
  }
  return { bytes: Buffer.from(cleaned, "base64") };
}

/**
 * 字节 → 内联文本。
 *
 * 默认按 UTF-8 返回；一旦出现替换字符（U+FFFD）就说明这不是文本，改回 base64，
 * 并附带一句说明 —— 让模型看到「这是二进制」，而不是看到一堆乱码替换符。
 */
function encodeContent(
  bytes: Buffer,
  encoding: unknown,
): { text: string; encoding: "utf8" | "base64"; note?: string } {
  if (encoding === "base64") return { text: bytes.toString("base64"), encoding: "base64" };
  const utf8 = bytes.toString("utf8");
  if (utf8.includes("\uFFFD")) {
    return {
      text: bytes.toString("base64"),
      encoding: "base64",
      note: "the file is not valid UTF-8, so its content is returned as base64",
    };
  }
  return { text: utf8, encoding: "utf8" };
}

/**
 * 把文本里的换行统一成 CR。
 *
 * 终端的「Enter」是 `\r`；`\n` 只是一个普通字符。PowerShell 收到裸 `\n` 会把它
 * 当换行显示，但不会执行命令 —— 用户看到的就是「文本进去了、光标在行尾、什么都没发生」。
 * 同时把 `\r\n` 折叠成单个 `\r`，避免 Windows 换行被当成两次回车。
 */
function toTerminalInput(value: string): string {
  return value.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
