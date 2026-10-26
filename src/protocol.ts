/**
 * 视图 ↔ 主进程的线协议。**纯数据，无副作用**：这一层能被单测直接持有，
 * 也是版本漂移唯一会以「解析错」而非「静默错」暴露的地方。
 *
 * 两条通道：
 *   1. 控制面：`pluginBridge.invoke("term.*", payload)` → 主进程 `onPanelInvoke`。
 *      宿主对自定义通道有 30s 转发超时（PLUGIN_PANEL_TIMEOUT_MS），
 *      所以这里**只允许短调用**；任何「等终端输出」的语义都不放在这里。
 *   2. 数据面：主进程在本机回环端口上提供 NDJSON 流，视图用 fetch 流式读取，
 *      详见 relay/protocol.ts。
 *
 * 输入数据一律 base64：终端字节不是 UTF-8 文本（多字节字符会被 read 边界切开），
 * 用字符串承载会在某些输入法/粘贴场景下静默截断。
 */

export const PROTOCOL_VERSION = 1;

/** 会话种类。`local` 走 fancy-pty，`ssh` 走 ssh2。 */
export type SessionKind = "local" | "ssh";

/**
 * 会话状态。
 *   starting 正在建立（pty 尚未就绪 / SSH 正在握手）
 *   running  可交互
 *   closed   正常结束（用户退出 shell 或远端退出）
 *   failed   建立失败或异常断开（message 里有原因）
 */
export type SessionStatus = "starting" | "running" | "closed" | "failed";

export interface SessionSummary {
  id: string;
  kind: SessionKind;
  title: string;
  status: SessionStatus;
  /** 当前工作目录；SSH 在握手后异步补齐。 */
  cwd: string;
  /** 仅 SSH 会话有值。 */
  profileId?: string;
  /** 单调递增的输出序号：视图用它做断点续读，模型用它读增量。 */
  seq: number;
  cols: number;
  rows: number;
  createdAt: number;
  /** 状态为 failed 时的可读原因。 */
  message?: string;
  /**
   * 是否是面板当前显示的那个会话。
   *
   * 由视图在切标签时上报（`term.session.activate`），所以它描述的是**用户眼前**
   * 的终端，而不是「最近创建」或「最近有输出」。面板没打开时全为 false。
   */
  active?: boolean;
  /**
   * 正在等待用户确认的主机指纹（首次连接某台 unknown 主机时出现）。
   *
   * ── 为什么它必须在摘要里 ──────────────────────────────────────────────
   * 宿主没有「插件 → 面板」的推送通道，而建立会话的那次 `invoke` 正被连接流程
   * **堵住**（它在等这个确认）。视图若只在同一条调用链里等这个信息，就会和连接
   * 互相等待到超时。把待确认项放进摘要，视图的 1 秒轮询就能看见它并弹窗；用户
   * 点按钮后视图回填 `term.hostkey.decide`，等待中的连接才继续。
   */
  hostKeyPending?: { host: string; port: number; fingerprint: string };
}

/** 输出分块。seq 是**该块最后一段**的序号，便于做「我读到了哪里」。 */
export interface OutputChunk {
  seq: number;
  /** base64 编码的原始字节。 */
  data: string;
}

export type SshAuthKind = "agent" | "key" | "password";

/** 连接档案。**永远不含明文密码**：密码在 secrets.ts 里单独加密存储。 */
export interface SshProfile {
  id: string;
  name: string;
  /**
   * 分组名。空串/缺省表示「未分组」（UI 归到 Ungrouped）。
   * 用自由文本而不是 id：用户按自己的心智分组，改个名字不必迁移任何东西。
   */
  group?: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuthKind;
  /** auth=key 时的私钥绝对路径。 */
  privateKeyPath?: string;
  /** 是否有已保存的密码（true 时视图显示「已保存」与小眼睛）。 */
  hasPassword?: boolean;
  /** 是否有已保存的私钥口令。 */
  hasPassphrase?: boolean;
  /** 跳板机：按顺序逐跳连接，最后一跳才是目标。 */
  jump?: Array<{ host: string; port: number; user: string; auth: SshAuthKind }>;
  /** 远端 TERM。默认 xterm-256color。 */
  term?: string;
  /** 登录后自动执行的命令。 */
  initialCommand?: string;
  /** 该主机专用的 keepalive 间隔（秒）；缺省用全局设置。 */
  keepaliveSeconds?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  defaultShell: string;
  defaultCwdMode: "workspace" | "home";
  scrollback: number;
  bufferBytes: number;
  maxSessions: number;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  confirmMultilinePaste: boolean;
  relayEnabled: boolean;
  sshKeepaliveSeconds: number;
}

/** Safe environment availability diagnostics; never contains variable values. */
export interface EnvironmentDiagnostics {
  variableCount: number;
  path: boolean;
  temp: boolean;
  home: boolean;
  shell: boolean;
}

/** 回环流的连接参数。token 只在这个响应里出现一次，且只存主进程内存。 */
export interface RelayInfo {
  url: string;
  token: string;
  expiresAt: number;
}

/** 所有通道的统一失败形状。code 是固定枚举，视图按它分支而不是匹配文案。 */
export type ErrorCode =
  | "NOT_FOUND"
  | "LIMIT"
  | "AUTH"
  | "HOSTKEY"
  | "UNSUPPORTED"
  | "TOO_LARGE"
  | "INVALID"
  | "INTERNAL";

export type Failure = { ok: false; code: ErrorCode; message: string };
export type Success<T> = { ok: true } & T;

/** 通道名集合：常量化的目的是让「路由表」与「调用点」在编译期就对齐。 */
export const CHANNELS = {
  ping: "term.ping",
  sessionsList: "term.sessions.list",
  sessionOpen: "term.session.open",
  sessionClose: "term.session.close",
  sessionRename: "term.session.rename",
  sessionReconnect: "term.session.reconnect",
  input: "term.input",
  resize: "term.resize",
  read: "term.read",
  profileList: "term.profile.list",
  profileSave: "term.profile.save",
  profileDelete: "term.profile.delete",
  profileReveal: "term.profile.reveal",
  profileTest: "term.profile.test",
  relayInfo: "term.relay.info",
  relayMux: "term.relay.mux",
  sessionActivate: "term.session.activate",
  settingsGet: "term.settings.get",
  settingsSet: "term.settings.set",
  fontsList: "term.fonts.list",
  upload: "term.upload",
  hostKeyDecision: "term.hostkey.decide",
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/** 终端输出的单块上限（回环流与控制面读取共用），防止一条巨型输出卡死通道。 */
export const MAX_CHUNK_BYTES = 512 * 1024;
/** 模型单次读取上限。 */
export const MAX_READ_BYTES = 64 * 1024;
/** 模型单次读取行数上限。 */
export const MAX_READ_LINES = 2000;
