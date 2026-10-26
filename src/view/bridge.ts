/**
 * 视图侧到主进程的桥。
 *
 * 视图是 `sandbox: true` 的 file:// 页面，只有 `window.pluginBridge` 一个入口：
 *   invoke(channel, payload) → Promise  控制面（短调用）
 *   on(event, handler)       → 退订     宿主固定事件（本插件只用 appearance:changed）
 *
 * 这一层刻意薄：它只做「把通道名收敛成函数」和「把统一失败形状抛成异常」。
 * 业务判断留在各个 UI 模块里，方便直接读代码就知道会发生什么。
 */

import { CHANNELS } from "../protocol.js";
import type {
  EnvironmentDiagnostics,
  Failure,
  RelayInfo,
  SessionSummary,
  SshProfile,
  AppSettings,
} from "../protocol.js";

interface PluginBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    pluginBridge?: PluginBridge;
  }
}

/** 视图侧的调用错误：带上 code，UI 可以按它分支而不是匹配文案。 */
export class BridgeError extends Error {
  constructor(
    readonly code: Failure["code"] | "BRIDGE",
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function bridge(): PluginBridge {
  const found = window.pluginBridge;
  if (!found) {
    // 只有直接在浏览器里打开 index.html 才会走到这里；给出可行动的说明。
    throw new BridgeError(
      "BRIDGE",
      "pluginBridge is unavailable. Open this view from PI-Desktop's work panel (Terminal), not directly in a browser.",
    );
  }
  return found;
}

async function call<T>(channel: string, payload?: Record<string, unknown>): Promise<T> {
  const raw = await bridge().invoke(channel, payload ?? {});
  if (raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === false) {
    const failure = raw as Failure;
    throw new BridgeError(failure.code ?? "INTERNAL", failure.message ?? "the terminal plugin refused this call");
  }
  return raw as T;
}

export interface OpenSessionResult {
  session: SessionSummary;
  relay: RelayInfo | null;
}

export const api = {
  ping: () =>
    call<{
      version: string;
      relay: boolean;
      sessions: number;
      environment: EnvironmentDiagnostics;
    }>(CHANNELS.ping),

  listSessions: () => call<{ sessions: SessionSummary[] }>(CHANNELS.sessionsList),

  openSession: (input: { kind: "local" | "ssh"; cols: number; rows: number; profileId?: string; title?: string }) =>
    call<OpenSessionResult>(CHANNELS.sessionOpen, input),

  closeSession: (id: string) => call<{ ok: true }>(CHANNELS.sessionClose, { id }),

  /** 上报「面板当前显示哪个会话」（模型工具 active 字段的来源）。 */
  setActiveSession: (id: string | null) =>
    call<{ active: string | null }>(CHANNELS.sessionActivate, { id }),

  renameSession: (id: string, title: string) =>
    call<{ session: SessionSummary }>(CHANNELS.sessionRename, { id, title }),

  reconnect: (id: string) => call<OpenSessionResult>(CHANNELS.sessionReconnect, { id }),

  writeInput: (id: string, data: Uint8Array) =>
    call<{ seq: number }>(CHANNELS.input, { id, data: toBase64(data) }),

  resize: (id: string, cols: number, rows: number) => call<{ ok: true }>(CHANNELS.resize, { id, cols, rows }),

  read: (id: string, fromSeq: number, maxBytes: number) =>
    call<{ chunks: Array<{ seq: number; data: string }>; nextSeq: number; truncated: boolean }>(CHANNELS.read, {
      id,
      fromSeq,
      maxBytes,
    }),

  relayInfo: (id: string) => call<RelayInfo>(CHANNELS.relayInfo, { id }),

  /** 一条覆盖全部活动会话的令牌：视图只开一条复用连接（见 relay-mux.ts）。 */
  relayMux: () => call<RelayInfo>(CHANNELS.relayMux),

  listProfiles: () => call<{ profiles: SshProfile[] }>(CHANNELS.profileList),

  saveProfile: (input: Record<string, unknown>) => call<{ profile: SshProfile }>(CHANNELS.profileSave, input),

  deleteProfile: (id: string) => call<{ ok: true }>(CHANNELS.profileDelete, { id }),

  revealSecret: (id: string, kind: "password" | "passphrase") =>
    call<{ value: string; kind: string; expiresInMs: number }>(CHANNELS.profileReveal, { id, kind }),

  /**
   * 连接自检。返回的是探测结果，**不是会话**：自检不占会话名额，所以终端开满
   * 时也测得动（旧实现开临时会话，于是会报「最多 N 个会话」）。
   */
  testProfile: (id: string) =>
    call<{ host: string; port: number; elapsedMs: number; fingerprint?: string }>(CHANNELS.profileTest, { id }),

  getSettings: () =>
    call<{
      settings: AppSettings;
      /** 默认值（与宿主 DEFAULT_SETTINGS 同源）：设置面板的「重置」需要它。 */
      defaults?: AppSettings;
      secretStore: { backend: string; degraded: boolean; detail: string };
    }>(
      CHANNELS.settingsGet,
    ),

  setSettings: (settings: Partial<AppSettings>) =>
    call<{ settings: AppSettings; defaults?: AppSettings }>(CHANNELS.settingsSet, { settings }),

  /** 已安装的字体族；「是不是等宽」由视图用 canvas 实测（见 view/fonts.ts）。 */
  listFonts: () => call<{ families: string[]; monospace: string[] }>(CHANNELS.fontsList),

  decideHostKey: (input: { host: string; port: number; fingerprint: string; accepted: boolean }) =>
    call<{ delivered: boolean }>(CHANNELS.hostKeyDecision, input),

  /** 宿主当前外观（`{ base: "light" | "dark" | "system", theme }`）。 */
  /**
   * 宿主当前语言（BCP-47，如 `zh-CN`）。
   *
   * 宿主明确把 `app.getLocale` 定为「插件 UI 自行本地化」的信号来源，因此这是
   * 唯一正确的语言入口 —— 不去读 navigator.language，那在多语言系统上经常
   * 与用户为应用选的语言不一致。
   */
  getLocale: async (): Promise<string> => {
    try {
      const value = await bridge().invoke("app.getLocale");
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  },

  getAppearance: async (): Promise<unknown> => {
    try {
      return await bridge().invoke("app.getAppearance");
    } catch {
      // 宿主版本差异下可能不提供该通道：退回「跟随系统」。
      return null;
    }
  },

  /**
   * 剪贴板读取的兜底通道。
   *
   * 为什么需要：`navigator.clipboard.readText()` 在沙箱页里经常被策略拒绝
   * （没有 focus、没有用户激活、或宿主禁用了剪贴板权限），而右键粘贴正是
   * 最需要它可用的场景。宿主侧有 `clipboard.read` 能力，插件的面板通道
   * 可以直接请求它；两条路都失败时才如实告诉用户。
   */
  readClipboardText: async (): Promise<string | null> => {
    const raw = await bridge().invoke("clipboard.readText", {});
    if (raw && typeof raw === "object") {
      const value = (raw as { text?: unknown }).text;
      if (typeof value === "string") return value;
    }
    return typeof raw === "string" ? raw : null;
  },

  onAppearanceChanged: (handler: (appearance: unknown) => void) =>
    bridge().on("appearance:changed", handler),
};

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
