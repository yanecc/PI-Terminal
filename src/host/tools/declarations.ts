/**
 * 模型工具声明清单（v1.0.0：按「对象」聚合，名字不带前缀）。
 *
 * 这份数组同时被两处消费：
 *   1. `manifest.ts` → `contributes.agentTools`（宿主据此展示风险等级与 schema，
 *      并在安装时让用户审阅）；
 *   2. `tools/index.ts` → 逐条 `pi.agent.registerTool`。
 * 一份数据两处用，是为了让「声明的工具」和「实际注册的工具」不可能漂移。
 *
 * ── 为什么不带 `terminal_` 前缀 ────────────────────────────────────────────
 * 宿主注册工具时会自己加上插件身份前缀（`plugin_local_pi_terminal_`）。工具名
 * 再写一遍 `terminal_` 就变成 `…_terminal_terminal_read` —— 又长又是同义反复，
 * 模型抄名字时也更容易漏写一段。所以这里只用最短的动词/对象名：
 * read / send / wait / upload / download / session / profile / setting。
 *
 * ── 风险等级是取组内最高 ──────────────────────────────────────────────────
 * 宿主按**工具**征求用户同意，不按 action。所以：
 *   · session  = medium（list 很轻，create/close 也不可逆地影响 shell）
 *   · profile  = high（delete 会连同已保存的凭据一起删掉，无法撤销）
 *   · setting  = medium
 *   · upload / download = high（双向改动文件系统）
 * 宁可让一次 list 多问一句，也不让一次 delete 悄悄发生。
 *
 * ── 一条贯穿全部工具的规则 ────────────────────────────────────────────────
 * **索引参数缺省不等于「全部」**：省略 sessionId / profileId / key 一律报错。
 * 要批量重置设置必须显式写 `key: "*"`。一次漏参的调用绝不能变成批量修改。
 */

export interface ToolDeclaration {
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** 索引参数缺失时的统一提示（模型据此补参数）。 */
const INDEX_RULE =
  "Omitted index parameters never mean \"all\": the call is refused instead of acting on every item.";

/** upload / download 共用的 `stream` 说明。 */
const STREAM_RULE =
  "stream=false (default) transfers with parallel chunks (fastPut/fastGet, and uploadDir/downloadDir's fast variants): " +
  "fastest on large files but needs server support for the extended requests. stream=true uses a single readable/writable " +
  "stream (put(readable) / get(remotePath, writable), useFastput:false / useFastget:false for folders): works on any server.";

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "read",
    description:
      "Read recent output from a terminal session as text (secrets are redacted). Use the returned nextSeq as fromSeq for the next call to read only new output.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from session action=list." },
        fromSeq: {
          type: "number",
          description: "Read output whose block sequence is >= this value. Omit to read the most recent screen.",
        },
        maxLines: { type: "number", description: "Maximum lines to return (default 200, max 2000)." },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "send",
    description:
      "Type text into a terminal session, optionally pressing Enter, and return the output produced afterwards. Multi-line text is written verbatim (each newline is executed/pressed), so prefer one command per call. This runs commands on the user's machine, so the host asks for confirmation first.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from session action=list." },
        text: { type: "string", description: "Text to type. Do not append a newline yourself." },
        enter: { type: "boolean", description: "Press Enter after typing (default true)." },
        waitMs: {
          type: "number",
          description:
            "How long to wait for output after writing, in milliseconds (default 2500, max 20000). Output that stays quiet for 800 ms ends the wait early.",
        },
      },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description:
      "Wait until a terminal session stops producing output (quiet window) or a timeout passes, then return the new output. Useful after send for long-running commands.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from session action=list." },
        fromSeq: { type: "number", description: "Start reading from this sequence (default: only output produced while waiting)." },
        quietMs: { type: "number", description: "Consider output finished after this much silence (default 1200)." },
        timeoutMs: { type: "number", description: "Give up waiting after this long (default 15000, max 60000)." },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "upload",
    description:
      "Copy data to the machine behind an SSH session, over that session's own authenticated connection. Three shapes, chosen by what you pass: (1) inline text — content with encoding=\"utf8\" (or encoding=\"base64\" for binary); " +
      "(2) one local file — localPath pointing at a file, uploaded to remotePath; (3) a whole local folder — localPath pointing at a directory, whose contents are copied into the remotePath directory (created if missing). " +
      "remotePath must be absolute. " +
      STREAM_RULE +
      " 32 MiB limit for inline content.",
    risk: "high",
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "An SSH session id." },
        remotePath: { type: "string", description: "Absolute path on the remote host (target file, or target directory when uploading a folder)." },
        content: { type: "string", description: "Inline content: UTF-8 text, or base64 when encoding=\"base64\". Mutually exclusive with localPath." },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "How to interpret content (default utf8). Only used with content.",
        },
        localPath: {
          type: "string",
          description: "Absolute path on this machine: a file to upload, or a folder whose contents are uploaded. Mutually exclusive with content.",
        },
        mode: { type: "string", description: "Octal file mode, default 644 (applies to files, not to folder uploads)." },
        stream: { type: "boolean", description: "Use a single readable stream instead of parallel chunks (default false)." },
      },
      required: ["sessionId", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "download",
    description:
      "Copy data from the machine behind an SSH session to this machine, over that session's own authenticated connection. " +
      "A file with localPath is saved there (parent folders are created); a file without localPath is returned inline as text/base64 when it fits the inline limit. " +
      "A folder always needs localPath and is copied recursively into it. remotePath must be absolute. " +
      STREAM_RULE,
    risk: "high",
    schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "An SSH session id." },
        remotePath: { type: "string", description: "Absolute path on the remote host: a file, or a directory to copy recursively." },
        localPath: {
          type: "string",
          description: "Absolute path on this machine: the target file, or the target folder for a directory download. Omit to get a small file's content back inline.",
        },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "How to return inline content (default utf8, or base64 when the bytes are not valid UTF-8).",
        },
        maxBytes: { type: "number", description: "Inline limit in bytes (default 262144, max 1048576). Ignored when localPath is given." },
        stream: { type: "boolean", description: "Use a single writable stream instead of parallel chunks (default false)." },
      },
      required: ["sessionId", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "session",
    description:
      "Manage terminal sessions (tabs). action=list returns id/kind/title/status/cwd/seq/active (active marks the tab the user is looking at); action=create opens a local shell (optionally a specific shell binary and working directory) or an SSH session for a saved profile; action=close ends a session and the process or remote shell behind it — pass sessionId=\"*\" to close every session. " +
      INDEX_RULE +
      ' action=close therefore requires "sessionId" (use "*" for all of them).',
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "close"], description: "What to do." },
        sessionId: {
          type: "string",
          description: 'action=close: id from action=list (required), or "*" to close every session.',
        },
        kind: { type: "string", enum: ["local", "ssh"], description: "action=create: session kind (default local)." },
        profileId: { type: "string", description: "action=create with kind=ssh: id from profile action=list." },
        cwd: {
          type: "string",
          description: "action=create with kind=local: absolute directory to start in (defaults to the project root).",
        },
        shell: {
          type: "string",
          description:
            "action=create with kind=local: shell to start — a command name resolved on PATH (e.g. nu, bash) or an absolute path (e.g. C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe). No arguments. Defaults to the plugin's default shell setting.",
        },
        title: { type: "string", description: "action=create: tab title (optional)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "profile",
    description:
      "Manage saved SSH connections. action=list shows id/name/host/user/auth (never passwords); action=create adds one; action=update changes an existing one; action=delete removes it together with its stored credentials; action=test opens a short-lived connection to verify the host key and authentication, then closes it. " +
      INDEX_RULE +
      ' update/delete/test therefore require "profileId". Passwords and key passphrases are never accepted: the user enters those in the panel.',
    risk: "high",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "update", "delete", "test"], description: "What to do." },
        profileId: { type: "string", description: "update/delete/test: id from action=list (required)." },
        name: { type: "string", description: "create/update: display name; defaults to the host." },
        group: { type: "string", description: "create/update: free-text group; empty string moves it out of any group." },
        host: { type: "string", description: "create/update: hostname or IP address (not a URL)." },
        port: { type: "number", description: "create/update: SSH port, default 22." },
        user: { type: "string", description: "create/update: login user." },
        auth: { type: "string", enum: ["agent", "key", "password"], description: "create/update: authentication method." },
        privateKeyPath: {
          type: "string",
          description: "create/update: absolute path to the private key when auth=key; empty string clears it.",
        },
        term: { type: "string", description: "create/update: remote TERM, default xterm-256color." },
        initialCommand: { type: "string", description: "create/update: command to run after login." },
        keepaliveSeconds: { type: "number", description: "create/update: per-host keepalive interval (5-300)." },
        jump: {
          type: "array",
          description: "create/update: jump hosts, in connection order (max 4).",
          items: {
            type: "object",
            properties: {
              host: { type: "string" },
              port: { type: "number" },
              user: { type: "string" },
              auth: { type: "string", enum: ["agent", "key", "password"] },
            },
            required: ["host", "user"],
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "setting",
    description:
      'Manage terminal settings. action=list returns every setting with its default; action=get returns one key (requires "key"); action=update applies an explicit patch given as "settings"; action=reset restores defaults. ' +
      INDEX_RULE +
      ' action=get and action=reset therefore require "key", and resetting everything requires key="*" explicitly.',
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "update", "reset"], description: "What to do." },
        key: {
          type: "string",
          description:
            'get/reset: the setting key to act on (required). Use "*" with action=reset to reset every setting. One of: ' +
            "defaultShell, defaultCwdMode, scrollback, bufferBytes, maxSessions, fontSize, fontFamily, cursorBlink, confirmMultilinePaste, relayEnabled, sshKeepaliveSeconds.",
        },
        settings: {
          type: "object",
          description:
            'update: an explicit patch, e.g. { "fontSize": 14, "cursorBlink": false }. Only known keys are accepted; wrong types are reported instead of ignored; out-of-range numbers are clamped.',
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];
