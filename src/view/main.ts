/**
 * 视图主界面。
 *
 * 结构很朴素：左边一列会话标签，右边是终端 + 状态条；SSH 连接与设置用覆盖层。
 * 刻意不引入 React/Vue：这个视图的交互面很小（点标签、敲键盘、填一个表单），
 * 用原生 DOM 反而更容易保持「一眼看懂」并且构建产物只有几十 KB。
 *
 * 所有状态都在 `state` 里，渲染是「整体重画标签 + 复用终端实例」：
 * 终端是重对象，绝不能因为切标签而重建（否则滚动历史和正在跑的程序都会断）。
 */

import type { AppSettings, SessionSummary, SshProfile } from "../protocol.js";
import { api, bridge, BridgeError, type OpenSessionResult } from "./bridge.js";
import { SessionStream, type StreamStatus } from "./stream.js";
import { createTerminal, type TerminalHandle } from "./terminal.js";
import { canvasMeasure, pickMonospaceFamilies } from "./fonts.js";
import { relayMux } from "./relay-mux.js";
import { DEFAULT_SETTINGS } from "../host/settings.js";
import { applyBase, currentBase, resolveBase, type Appearance } from "./theme.js";
import {
  buildProfileForm,
  fillGroupSuggestions,
  renderProfileManager,
  renderSshPicker,
  type ProfilePanelHandlers,
} from "./profiles.js";
import { getLocale, resolveLocale, setLocale, t } from "./i18n.js";

/**
 * 供 scripts/view-behavior.mjs 在真实 Chromium 里驱动的最小导出面。
 * 导出本身不改变行为：生产代码走的是同一批函数。
 */
export { applyBase, currentBase, resolveBase };
export { createTerminal } from "./terminal.js";
// 行为测试需要直接驱动这几块（生产代码用的是同一批实现）。
export { buildProfileForm, renderProfileManager, renderSshPicker, groupProfiles } from "./profiles.js";
export { setLocale, getLocale, t } from "./i18n.js";

/**
 * 写入通道的可注入点。
 *
 * 生产环境永远走 `api.writeInput`（→ 宿主桥）；测试里没有真实会话，用它把
 * 写入替换成可观测的桩，从而断言「粘贴/按键到底送出了什么字节」，而不是靠
 * 读代码猜。
 */
let writeInputImpl: (sessionId: string, bytes: Uint8Array) => Promise<unknown> = (sessionId, bytes) =>
  api.writeInput(sessionId, bytes);

export function __setWriteInputForTest(
  impl: ((sessionId: string, bytes: Uint8Array) => Promise<unknown>) | null,
): void {
  writeInputImpl =
    impl ?? ((sessionId, bytes) => api.writeInput(sessionId, bytes));
}


interface SessionView {
  summary: SessionSummary;
  terminal: TerminalHandle | null;
  stream: SessionStream | null;
  status: StreamStatus;
  unread: boolean;
  detail?: string;
  element: HTMLDivElement | null;
}

const state = {
  settings: null as AppSettings | null,
  /** 宿主下发的默认值：每行右侧的「重置」用它们写回。 */
  defaults: null as AppSettings | null,
  secretStore: null as { backend: string; degraded: boolean; detail: string } | null,
  sessions: new Map<string, SessionView>(),
  activeId: null as string | null,
  profiles: [] as SshProfile[],
  pendingHostKey: null as { host: string; port: number; fingerprint: string } | null,
  /**
   * 面板中央显示什么。
   *
   *   terminal → 会话终端（每个会话一个 surface，靠 hidden 切换）
   *   hosts    → 主机管理面板（与终端平级，不再是浮层）
   *
   * 两者共用同一个 stage：这样「主机」就是面板的一部分，而不是压在上面的对话框；
   * 切回终端时只是把 surface 重新显示出来，终端实例从未被销毁。
   */
  pane: "terminal" as "terminal" | "hosts" | "settings",
  /** 正在就地重命名的会话 id（标签会切成输入框）。 */
  renamingId: null as string | null,
  overlay: null as "picker" | "profileForm" | "hostkey" | null,
};

const dom = {
  root: null as HTMLElement | null,
  tabs: null as HTMLElement | null,
  stage: null as HTMLElement | null,
  status: null as HTMLElement | null,
  overlay: null as HTMLElement | null,
  /** 「主机」固定入口按钮：面板打开中要能显示选中态。 */
  hostsBtn: null as HTMLButtonElement | null,
};

let sessionSyncTimer: number | null = null;
let sessionSyncInFlight = false;
let lastSessionSyncError = "";
/**
 * 每个会话「在服务端列表里连续缺失」的次数。
 *
 * 用计数而不是一次判定：listSessions 是异步的，会在会话刚创建、注册表尚未
 * 反映时返回旧快照；单次缺失不足以说明会话真的结束了。
 */
const missingCount = new Map<string, number>();
/** 刚创建的会话在这么长时间内不参与「缺失即删除」的判定。 */
const MISSING_GRACE_MS = 8_000;
/** 连续这么多次缺失才判定会话真的没了（同步间隔 1s）。 */
const MISSING_TOLERANCE = 3;
let shortcutsInstalled = false;
/**
 * 「新建本地」是否正在进行。
 *
 * openSession 要真的拉起一个 pty，慢的时候几秒；这期间重复点击会各自建一个
 * 会话。用户看到的是「点了一下没反应」（第一次还在路上），随后又莫名多出标签。
 */
let openingLocal = false;
/**
 * 最近一次「新建本地」失败的原因。
 *
 * 状态条只保留一行，且会被后续的同步/轮询消息覆盖；把它单独留在空状态里，
 * 用户重进面板时仍能看到失败原因。成功建出会话时清空。
 */
let lastOpenError = "";
/** 正在新增/编辑的主机档案（浮层打开期间有效）。 */
let pendingProfileEdit: SshProfile | null = null;

/* ── 启动 ─────────────────────────────────────────────────────────────── */

export async function boot(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root is missing");
  dom.root = root;

  // 语言要在**任何文案渲染之前**就位：先问宿主，再画界面，避免先闪一下英文。
  await syncLocale();
  renderShell();

  try {
    const settings = await api.getSettings();
    state.settings = settings.settings;
    state.defaults = settings.defaults ?? null;
    state.secretStore = settings.secretStore;
  } catch (error) {
    setStatus(t("status.settingsFailed", { message: messageOf(error) }), "error");
  }
  // 设置可能被**插件外**改动（模型工具 setting update）：宿主沿回环流
  // 推送，这里订阅；回环流不可用时还有下面的轮询兜底。
  relayMux.setSettingsListener(applyRemoteSettings);
  startSettingsPoll();

  try {
    const { sessions } = await api.listSessions();
    for (const summary of sessions) {
      state.sessions.set(summary.id, {
        summary,
        terminal: null,
        stream: null,
        status: "connecting",
        unread: false,
        element: null,
      });
    }
    // 面板可能是「重开」的：这时已有一个连接在等确认，摘要里带着 hostKeyPending。
    applyPendingHostKey(sessions);
    const running = sessions.find((session) => session.status === "running") ?? sessions[0];
    if (running) await activate(running.id);
  } catch (error) {
    setStatus(t("status.hostsLoadFailed", { message: messageOf(error) }), "error");
  }

  try {
    const { profiles } = await api.listProfiles();
    state.profiles = profiles;
  } catch {
    state.profiles = [];
  }

  await syncAppearance();
  api.onAppearanceChanged((appearance) => {
    applyAppearance(appearance as Appearance | null);
    // 语言也随这个载荷到达：变了就整体重绘（终端字节流不动）。
    void syncLocale(appearance as Appearance | null).then((changed) => {
      if (changed) rerenderForLocale();
    });
  });
  // 显式跟随系统：宿主 base=system 时它自己也用这条规则，监听它才真正「一致」。
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (document.documentElement.dataset.themePreference !== "system") return;
      applyAppearance({ base: "system" });
    });
  } catch {
    /* 老内核没有 addEventListener 版本，静默跳过 */
  }

  renderTabs();
  renderEmptyState();
  startSessionSync();
}

/**
 * 同步语言。
 *
 * 宿主把语言放在**外观载荷**里一起下发（`app.getAppearance()` 与
 * `appearance:changed` 都是 `{ base, theme, locale }`），这是它自己的面板模板
 * 用的同一条路径。因此这里优先读载荷里的 `locale`，拿不到才退回
 * `app.getLocale`，最后才是浏览器语言。
 */
async function syncLocale(appearance?: Appearance | null): Promise<boolean> {
  const fromAppearance = typeof appearance?.locale === "string" ? appearance.locale : "";
  let raw = fromAppearance;
  if (!raw) {
    // 外观载荷里没有 locale（旧宿主）：单独问一次。
    const answer = await api.getAppearance().catch(() => null);
    const asRecord = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : null;
    raw = typeof asRecord?.locale === "string" ? asRecord.locale : "";
  }
  if (!raw) raw = await api.getLocale().catch(() => "");
  return setLocale(resolveLocale(raw || navigator.language));
}

/**
 * 语言切换后重绘可见部分。
 *
 * 不重建终端：终端里是字节流，重绘它等于把用户正在看的输出清掉。只重画
 * 外壳（按钮、标签、空状态）与当前打开的面板。
 */
function rerenderForLocale(): void {
  const overlayKind = state.overlay;
  renderShell();
  renderTabs();
  if (state.sessions.size === 0) renderEmptyState();
  for (const view of state.sessions.values()) {
    if (view.element) view.element.hidden = view.summary.id !== state.activeId;
  }
  if (overlayKind) showOverlay(overlayKind);
  const active = state.activeId ? state.sessions.get(state.activeId) : null;
  if (active) updateStatusLine(active);
}

/* ── 骨架 ─────────────────────────────────────────────────────────────── */

function renderShell(): void {
  const root = dom.root!;
  root.innerHTML = "";
  root.className = "term-root";

  const header = document.createElement("header");
  header.className = "term-header";

  const newLocal = button(`＋ ${t("app.newLocal")}`, t("app.newLocalHint"), () => void openLocal());
  newLocal.dataset.primary = "true";
  const newSsh = button(`＋ ${t("app.newSsh")}`, t("app.newSshHint"), () => showOverlay("picker"));
  // 面板只保留这三个固定入口。设置不再占用面板：唯一入口是宿主的「插件 - 设置」。
  const hosts = button(t("app.hosts"), t("app.hostsHint"), () => showHostsPane());
  hosts.dataset.fixed = "hosts";
  hosts.dataset.active = String(state.pane === "hosts");
  dom.hostsBtn = hosts;

  const settings = button(t("app.settings"), t("app.settingsHint"), () => void showSettingsPane());
  settings.dataset.fixed = "settings";
  settings.dataset.active = String(state.pane === "settings");

  const tabs = document.createElement("div");
  tabs.className = "term-tabs";
  tabs.setAttribute("role", "tablist");
  dom.tabs = tabs;

  header.append(newLocal, newSsh, hosts, settings, tabs);

  const stage = document.createElement("main");
  stage.className = "term-stage";
  dom.stage = stage;

  const status = document.createElement("footer");
  status.className = "term-status";
  status.setAttribute("role", "status");
  dom.status = status;

  const overlay = document.createElement("div");
  overlay.className = "term-overlay";
  overlay.hidden = true;
  dom.overlay = overlay;

  root.append(header, stage, status, overlay);

  const observer = new ResizeObserver(() => {
    const view = state.activeId ? state.sessions.get(state.activeId) : null;
    if (!view?.terminal) return;
    const size = view.terminal.refit();
    if (size) void api.resize(view.summary.id, size.cols, size.rows).catch(() => undefined);
  });
  observer.observe(stage);

  if (!shortcutsInstalled) {
    shortcutsInstalled = true;
    window.addEventListener(
      "keydown",
      (event) => {
        if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.repeat) return;
        const key = event.key.toLowerCase();
        // Capture before xterm's textarea or the host can consume this shortcut.
        if (key === "t" || event.code === "KeyT") {
          event.preventDefault();
          event.stopPropagation();
          void openLocal();
        } else if ((key === "w" || event.code === "KeyW") && state.activeId) {
          event.preventDefault();
          event.stopPropagation();
          void closeSession(state.activeId);
        }
      },
      true,
    );
  }
}

function renderTabs(): void {
  const tabs = dom.tabs;
  if (!tabs) return;
  tabs.innerHTML = "";
  for (const view of state.sessions.values()) {
    const { summary } = view;
    const tab = document.createElement("div");
    tab.className = "term-tab";
    tab.dataset.active = String(summary.id === state.activeId);
    // 用运行期状态而不是快照：summary 是「拿到手那一刻」的值，流推进状态后
    // 它不会跟着变。快照里的 starting/过期值曾让新终端被画成划线。
    tab.dataset.status = lifecycleOf(view);
    tab.dataset.unread = String(view.unread);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(summary.id === state.activeId));
    tab.tabIndex = 0;

    const dot = document.createElement("span");
    dot.className = "term-tab-dot";
    dot.dataset.kind = summary.kind;
    dot.dataset.status = view.status;

    let title: HTMLElement;
    if (state.renamingId === summary.id) {
      // 就地重命名。为什么不用 window.prompt：宿主 webview 默认禁用同步对话框，
      // prompt 直接返回 null —— 用户看到的就是「点了重命名什么也没发生」。
      const input = document.createElement("input");
      input.className = "term-tab-rename";
      input.value = summary.title;
      input.spellcheck = false;
      input.setAttribute("aria-label", t("tab.rename"));
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("dblclick", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void commitRename(summary.id, input.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelRename();
        }
      });
      input.addEventListener("blur", () => {
        // 点到别处 = 确认（与资源管理器一致）；空值按取消处理。
        if (state.renamingId === summary.id) void commitRename(summary.id, input.value);
      });
      title = input;
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    } else {
      const span = document.createElement("span");
      span.className = "term-tab-title";
      span.textContent = summary.title || summary.kind;
      span.title = `${summary.kind} · ${summary.cwd || "unknown cwd"}`;
      title = span;
    }

    const close = document.createElement("button");
    close.className = "term-tab-close";
    close.type = "button";
    // 用 SVG 而不是字符 "×"：字符的粗细/基线随字体变化，在 11px 的标签栏里
    // 会显得歪；SVG 用 currentColor，跟随主题且始终居中。
    close.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">' +
      '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    close.setAttribute("aria-label", t("status.closeLabel", { title: summary.title }));
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeSession(summary.id);
    });

    tab.append(dot, title, close);
    tab.addEventListener("click", () => void activate(summary.id));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void activate(summary.id);
      }
    });
    tab.addEventListener("dblclick", () => beginRename(summary.id));
    // 右键 = 选项卡菜单（复制会话 ID / 重命名）。终端区域的右键仍是粘贴，
    // 两者作用在不同元素上，不会互相干扰。
    tab.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showTabMenu(summary.id, event.clientX, event.clientY);
    });

    tabs.append(tab);
  }
}

/* ── 选项卡右键菜单 ───────────────────────────────────────────────────── */

/**
 * 右键菜单只有一个实例：再次右键会先收掉旧的。
 *
 * 为什么用浮层而不是原生菜单：宿主 webview 里没有 Electron 的 Menu API 可用，
 * 原生右键菜单只会被系统菜单顶掉；而这里只需要两个动作。
 */
let tabMenu: { element: HTMLElement; onPointer: (event: Event) => void; onKey: (event: KeyboardEvent) => void } | null =
  null;

function hideTabMenu(): void {
  if (!tabMenu) return;
  window.removeEventListener("pointerdown", tabMenu.onPointer, true);
  window.removeEventListener("keydown", tabMenu.onKey, true);
  tabMenu.element.remove();
  tabMenu = null;
}

function showTabMenu(id: string, x: number, y: number): void {
  hideTabMenu();
  const view = state.sessions.get(id);
  if (!view) return;

  const menu = document.createElement("div");
  menu.className = "term-tab-menu";
  menu.dataset.role = "tabMenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("tab.menu"));

  menu.append(
    tabMenuItem(t("tab.copyId"), () => {
      hideTabMenu();
      void copyPlainText(view.summary.id, t("status.copiedId", { id: view.summary.id }));
    }),
    tabMenuItem(t("tab.rename"), () => {
      hideTabMenu();
      beginRename(view.summary.id);
    }),
  );

  document.body.append(menu);
  // 贴边翻转：菜单不能跑出窗口。
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;

  const onPointer = (event: Event): void => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    hideTabMenu();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    hideTabMenu();
  };
  // 下一拍再挂监听：否则这次 contextmenu 之前的 pointerdown 会立刻关掉菜单。
  setTimeout(() => {
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
  }, 0);
  tabMenu = { element: menu, onPointer, onKey };
}

function tabMenuItem(label: string, run: () => void): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "term-tab-menu-item";
  item.setAttribute("role", "menuitem");
  item.textContent = label;
  item.addEventListener("click", run);
  return item;
}

/** 复制任意文本：先试浏览器剪贴板，失败再走宿主能力（沙箱页常见）。 */
async function copyPlainText(text: string, okMessage: string): Promise<void> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      setStatus(okMessage, "info");
      return;
    }
  } catch {
    // 沙箱页未聚焦时会被拒绝：落到宿主桥。
  }
  if (await writeClipboardViaHost(text)) setStatus(okMessage, "info");
  else setStatus(t("status.copyFailed"), "error");
}
/**
 * 标签上显示的「生命周期」。
 *
 * 把流状态（live/polling/connecting/closed/error）归并成标签需要的三类：
 * 结束（划线）、出错（红点）、其它（正常）。快照里的 `summary.status` 只在
 * 服务端明确表示终态时才参考 —— 否则以运行期状态为准。
 */
function lifecycleOf(view: SessionView): "running" | "closed" | "failed" {
  if (view.status === "closed") return "closed";
  if (view.status === "error") return "failed";
  if (view.summary.status === "failed") return "failed";
  if (view.summary.status === "closed") return "closed";
  return "running";
}

function renderEmptyState(): void {
  const stage = dom.stage;
  if (!stage || state.sessions.size > 0) return;
  // 主机面板与终端各自负责自己的内容：空状态只在终端面板下出现。
  if (state.pane !== "terminal") return;
  clearNonSessionPanels(stage);
  const empty = document.createElement("div");
  empty.className = "term-empty";
  empty.dataset.role = "empty";
  // 失败原因要能停在面板中央，而不只是状态条上闪一下。
  //
  // 之前「新建本地」失败的唯一可见反馈就是底部那行文字，它随后会被同步轮询
  // 或下一次 openLocal 的「正在启动…」覆盖掉，用户看到的就是「点了没反应」。
  // 把最近一次失败留在空状态里，用户至少知道发生了什么、下一步该做什么。
  const blocked = lastOpenError
    ? `<p class="term-blocked"><strong>${escapeHtml(
        t("empty.blocked", { message: lastOpenError }),
      )}</strong></p><p class="term-hint">${escapeHtml(t("empty.blockedHint"))}</p>`
    : "";
  empty.innerHTML = `
    <p><strong>${escapeHtml(t("empty.title"))}</strong></p>
    <p>${escapeHtml(t("empty.body"))}</p>
    ${blocked}
    <p class="term-hint">${escapeHtml(t("empty.hint"))}</p>
  `;
  stage.append(empty);
}

/* ── 会话激活与渲染 ───────────────────────────────────────────────────── */

async function activate(id: string): Promise<void> {
  const view = state.sessions.get(id);
  if (!view) return;
  view.unread = false;
  state.activeId = id;
  // 让宿主知道用户眼前是哪个终端：模型工具的 `active` 字段就来自这一次上报。
  void api.setActiveSession(id).catch(() => undefined);
  // 标签的「当前」高亮来自 `data-active`，而它只在 renderTabs() 里写。
  // 上一轮改 activate() 时把这里原有的 renderTabs() 连带删掉了：高亮于是只在
  // 「新标签被画出来」那一刻是正确的，之后每次切换只改 hidden、不重画标签，
  // 旧标签就一直是加深态。凡是改 activeId 的地方都必须重画。
  renderTabs();
  // 从主机面板切回终端时，把固定入口的选中态收回去。
  if (state.pane !== "terminal") {
    state.pane = "terminal";
    if (dom.hostsBtn) delete dom.hostsBtn.dataset.active;
    markSettingsButton(false);
  }

  const stage = dom.stage;
  if (!stage) return;

  // 只清掉「不是会话终端」的东西（空状态、主机面板）。
  //
  // 这里曾经是 `stage.innerHTML = ""` —— 它会把**其它会话**已经建好的终端元素
  // 一起从 DOM 里摘掉。那些 view.element 仍指向已脱离文档的节点，于是
  // 「打开一个新标签后，切回旧标签」看到的是一片空白（终端实例还活着，
  // 只是不在页面上）。
  //
  // 这一步必须**无条件**执行（不只是第一次建终端时）：从主机面板点标签切回来，
  // 走的正是「element 已存在」的分支，若不在这里清掉，主机面板会一直盖在上面。
  clearNonSessionPanels(stage);

  // 切换标签只换可见性，绝不 dispose 终端：重建会丢掉滚动历史并杀掉正在跑的程序。
  for (const other of state.sessions.values()) {
    if (other.element) other.element.hidden = other.summary.id !== id;
  }

  if (!view.element) {
    const host = document.createElement("div");
    host.className = "term-surface";
    host.dataset.role = "surface";
    stage.append(host);
    view.element = host;

    // 建终端是整个流程里唯一会「抛了就没有任何界面反馈」的地方：
    // 标签已经画出来了，面板却永远空白，用户看到的就是「点了没反应」。
    // 所以这里必须自己兜底并把错误摆到状态条上，而不是让它冒到 openLocal 的
    // catch 里（那里只写一行文字，而且脚本异常时连 setStatus 都可能还没就位）。
    let terminal: ReturnType<typeof createTerminal>;
    try {
      terminal = createTerminal({
        fontSize: state.settings?.fontSize ?? DEFAULT_SETTINGS.fontSize,
        fontFamily: state.settings?.fontFamily ?? "",
        cursorBlink: state.settings?.cursorBlink ?? true,
        scrollback: state.settings?.scrollback ?? 5000,
        onData: (data) => {
          if (!data) return;
          void api.writeInput(view.summary.id, new TextEncoder().encode(data)).catch((error) => {
            setStatus(t("status.inputFailed", { message: messageOf(error) }), "error");
          });
        },
        // Ctrl+C / Ctrl+V 必须在 xterm 之前拦截：xterm 自己会把 Ctrl+C 变成 ^C。
        shouldHandleKey: (event) => handleTerminalKey(event, view),
      });
      view.terminal = terminal;
      terminal.mount(host);
    } catch (error) {
      view.status = "error";
      setStatus(t("status.openLocalFailed", { message: messageOf(error) }), "error");
      console.error("[pi-terminal] could not create the terminal", error);
      renderTabs();
      return;
    }

    const size = terminal.refit();
    if (size) void api.resize(view.summary.id, size.cols, size.rows).catch(() => undefined);

    // 粘贴：既支持 Ctrl+V，也支持浏览器/系统输入法触发的 paste 事件。
    host.addEventListener("paste", (event) => {
      void handlePaste(event, view);
    });
    // 右键 = 粘贴（不弹菜单）。preventDefault 挡掉系统菜单，行为与终端一致。
    host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      void pasteFromClipboard(view);
    });

    await startStream(view);
  } else {
    for (const child of stage.children) (child as HTMLElement).hidden = true;
    view.element.hidden = false;
    view.terminal?.focus();
    const size = view.terminal?.refit();
    if (size) void api.resize(view.summary.id, size.cols, size.rows).catch(() => undefined);
  }

  updateStatusLine(view);
}

function startSessionSync(): void {
  if (sessionSyncTimer !== null) return;
  sessionSyncTimer = window.setInterval(() => void syncSessions(), 1000);
}

async function syncSessions(): Promise<void> {
  if (sessionSyncInFlight || document.hidden) return;
  sessionSyncInFlight = true;
  try {
    const { sessions } = await api.listSessions();
    const liveIds = new Set(sessions.map((session) => session.id));
    const added: SessionView[] = [];
    let changed = false;

    for (const summary of sessions) {
      const existing = state.sessions.get(summary.id);
      if (!existing) {
        // 关键：open 还没返回时，注册表里会短暂出现一个「半成品」条目
        // （status=starting、cwd=""、title=默认值）。它可能马上就因为建立失败
        // 被清掉 —— 如果这时把它收进视图，我们会得到一个永远不会再更新的
        // 幽灵视图：标签显示 local、state=starting、cwd 未知、没有终端，
        // 点它什么也不会发生。
        //
        // 判据：`starting` 且 cwd 为空 = 还在建立中。正在建立中的会话由
        // openLocal / connectProfile 在 open 返回后自己 addSession，轮询不要抢。
        // 外部来源（agent 工具）创建的会话最终会进入 running 并带上 cwd，
        // 到那时自然被收下。
        if (summary.status === "starting" && !summary.cwd) {
          continue;
        }
        const view: SessionView = {
          summary,
          terminal: null,
          stream: null,
          status: summary.status === "failed" ? "error" : summary.status === "closed" ? "closed" : "connecting",
          unread: true,
          element: null,
        };
        state.sessions.set(summary.id, view);
        added.push(view);
        changed = true;
        continue;
      }

      const previous = existing.summary;
      if (
        previous.title !== summary.title ||
        previous.cwd !== summary.cwd ||
        previous.status !== summary.status
      ) {
        changed = true;
      }
      existing.summary = summary;
      if (summary.status === "failed") existing.status = "error";
      else if (summary.status === "closed") existing.status = "closed";
    }

    // 主机指纹确认框由这里驱动：首连时摘要在建立过程中就带着 hostKeyPending。
    applyPendingHostKey(sessions);

    // 删除「服务端确实已经没有」的会话。
    //
    // 这里曾经有一个会把新终端吃掉的真 bug：只要某次 listSessions 的结果里
    // 没有某个会话就立刻 dispose 它，而这份列表可能慢一拍、或在会话刚创建、
    // 注册表还没反映出来时返回 —— 于是「刚新建的终端」被当成已消失：标签没了、
    // xterm 被 dispose、面板回到空状态。
    //
    // 现在加两道保护：
    //   · 刚创建（MISSING_GRACE_MS 内）的会话不参与删除；
    //   · 需要连续 MISSING_TOLERANCE 次缺失才判定真的没了。
    let activeRemoved = false;
    for (const [id, view] of state.sessions) {
      if (liveIds.has(id)) {
        missingCount.delete(id);
        continue;
      }
      if (Date.now() - view.summary.createdAt < MISSING_GRACE_MS) continue;

      const misses = (missingCount.get(id) ?? 0) + 1;
      if (misses < MISSING_TOLERANCE) {
        missingCount.set(id, misses);
        continue;
      }

      missingCount.delete(id);
      view.stream?.stop();
      view.terminal?.dispose();
      view.element?.remove();
      state.sessions.delete(id);
      if (state.activeId === id) activeRemoved = true;
      changed = true;
    }

    lastSessionSyncError = "";
    if (!changed) return;

    if (activeRemoved) state.activeId = null;
    renderTabs();
    if (state.sessions.size === 0) {
      renderEmptyState();
      // 不要把状态条清空：它此刻很可能正显示「无法启动本地终端：…」。
      // 之前这里无条件清空，于是用户点完按钮后，失败文案在一秒内被轮询抹掉，
      // 界面上什么都没留下 —— 这正是「点了没反应」的最后一环。
      if (dom.status && !lastOpenError) dom.status.textContent = "";
      return;
    }
    if (!state.activeId) {
      const next = [...state.sessions.keys()].pop();
      if (next) await activate(next);
      return;
    }
    const active = state.sessions.get(state.activeId);
    if (active) updateStatusLine(active);
    if (added.length > 0) {
      setStatus(t("status.sessionAvailable", { title: added[added.length - 1]!.summary.title }), "info");
    }
  } catch (error) {
    const message = messageOf(error);
    if (message !== lastSessionSyncError) {
      lastSessionSyncError = message;
      setStatus(t("status.sessionsSyncFailed", { message }), "error");
    }
  } finally {
    sessionSyncInFlight = false;
  }
}

async function startStream(view: SessionView): Promise<void> {
  // 只有**明确的终态**才拒绝建流。
  //
  // 旧代码写的是 `status !== "running"` 就当成结束 —— 但会话刚创建时快照可能是
  // `starting`，于是新终端一出现就被画成 closed（标签划线、标题显示
  // "unknown cwd"、面板空白）。`starting` 是「还没好」，不是「已经没了」：
  // 照样连流，状态由流自己的 onStatus 推进。
  const status = view.summary.status;
  if (status === "closed" || status === "failed") {
    view.status = status === "failed" ? "error" : "closed";
    renderTabs();
    updateStatusLine(view);
    return;
  }

  // 回环流由 relay-mux 统一维护（一条连接覆盖所有会话，绕开浏览器 6 连接上限）；
  // 这里只判断「设置里允许用回环流」。端口真的不通时复用层回调 onFatal，
  // 流自己降级到轮询。
  const relayEnabled = state.settings?.relayEnabled !== false;

  const stream = new SessionStream(
    view.summary.id,
    {
      onData: (bytes, _seq, done) => {
        if (!view.terminal) {
          done();
          return;
        }
        void view.terminal.write(bytes).finally(done);
      },
      onStatus: (status, detail) => {
        view.status = status;
        view.detail = detail;
        renderTabs();
        if (view.summary.id === state.activeId) updateStatusLine(view);
      },
    },
    // A newly-created xterm is empty, including after the panel webview reloads.
    // Replay the retained session output instead of starting after the latest chunk.
    0,
  );
  view.stream = stream;
  void stream.start(relayEnabled);
}

/* ── 剪贴板与右键菜单 ─────────────────────────────────────────────────── */

/**
 * 交给 xterm 的按键过滤器：返回 false 表示「这个键不给终端」。
 *
 * 为什么必须是同步的：`attachCustomKeyEventHandler` 的契约就是同步返回真假。
 * 因此复制/粘贴的异步工作放到微任务里启动，这里只负责「拦不拦」。
 *
 * 语义：
 *   Ctrl+C（无 Shift/Alt）有选中 → 复制并清掉选中（不发给 shell 当 ^C）；
 *   没有选中 → 放行，保持 shell 的 ^C 中断语义（这是终端的基本预期）。
 *   Cmd+C 在 macOS 上没有 ^C 含义，总是复制。
 *   Ctrl+V / Cmd+V → 读剪贴板粘贴；Shift+Insert 是终端里的传统粘贴键。
 */
export function handleTerminalKey(event: KeyboardEvent, view: Pick<SessionView, "terminal" | "summary">): boolean {
  const terminal = view.terminal;
  if (!terminal) return true;
  const key = event.key.toLowerCase();
  const plainCtrl = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;

  const isCopy = (plainCtrl && key === "c") || (event.metaKey && !event.ctrlKey && key === "c");
  if (isCopy) {
    if (terminal.hasSelection()) {
      event.preventDefault();
      void copySelection(terminal, view);
      return false;
    }
    // 无选中：macOS 的 Cmd+C 不该漏成 ^C（用户只是想复制）；Windows/Linux 的
    // Ctrl+C 要保留中断语义，所以放行。
    if (event.metaKey) {
      event.preventDefault();
      setStatus(t("status.nothingSelected"), "info");
      return false;
    }
    return true;
  }

  const isPaste =
    (event.ctrlKey && !event.altKey && key === "v") ||
    (event.metaKey && !event.ctrlKey && key === "v") ||
    (event.shiftKey && event.key === "Insert");
  if (isPaste) {
    event.preventDefault();
    void pasteFromClipboard(view);
    return false;
  }

  return true;
}

/**
 * 右键 = 粘贴（不弹菜单）。
 *
 * 终端里右键的肌肉记忆就是粘贴；多一层菜单等于每次多一次点击。需要复制时用
 * 「选中 + Ctrl+C」（见 handleTerminalKeydown），清屏/全选有命令面板，不必
 * 占用右键。
 *
 * 两个细节：
 *   · 右键会让 xterm 失焦，粘贴前先 focus 回来，否则光标位置看起来不对；
 *   · 选中状态下右键**仍然粘贴**并且不清掉选中，与 Windows Terminal 的默认
 *     行为一致 —— 用户刚复制的范围还在。
 */
export async function pasteFromClipboard(view: Pick<SessionView, "terminal" | "summary">): Promise<void> {
  view.terminal?.focus();
  const text = await readClipboardText();
  if (text === null) {
    setStatus(t("status.clipboardUnavailable"), "error");
    return;
  }
  if (!text) {
    setStatus(t("status.clipboardEmpty"), "info");
    return;
  }
  await pasteText(text, view);
}

/** 读剪贴板：优先异步 API，失败再试 Electron 暴露的桥（都不行就返回 null）。 */
/**
 * 读剪贴板：先试浏览器 API，失败再走宿主桥。
 *
 * 面板是沙箱页，`navigator.clipboard.readText()` 在「页面未聚焦」或「宿主没给
 * 剪贴板权限」时会 reject —— 而右键粘贴恰恰最容易在这种状态下发生。宿主桥
 * 那条路（`clipboard.read` 权限）通常仍然可用，所以不能把第一次失败当成终点。
 */
let clipboardReader: (() => Promise<string | null>) | null = null;

/** 测试用：替换剪贴板来源（生产代码永远走默认实现）。 */
export function __setClipboardReaderForTest(reader: (() => Promise<string | null>) | null): void {
  clipboardReader = reader;
}

async function readClipboardText(): Promise<string | null> {
  if (clipboardReader) return clipboardReader();
  try {
    const text = await navigator.clipboard.readText();
    if (typeof text === "string") return text;
  } catch {
    // 落到宿主桥。
  }
  try {
    return await api.readClipboardText();
  } catch {
    return null;
  }
}

/**
 * 粘贴的唯一入口（右键、Ctrl+V、系统 paste 事件共用）。
 *
 * 多行内容先确认：一次粘贴十条命令再回车，和逐条执行是完全不同的事故面。
 * 单行不打扰（终端里最高频的粘贴就是一条命令或一个路径）。
 */
async function pasteText(text: string, view: Pick<SessionView, "terminal" | "summary">): Promise<void> {
  const lineCount = text.split("\n").length;
  if ((state.settings?.confirmMultilinePaste ?? true) && lineCount > 1) {
    const ok = window.confirm(t("status.pasteConfirm", { count: lineCount }));
    if (!ok) return;
  }
  try {
    await writeInputImpl(view.summary.id, new TextEncoder().encode(text));
    setStatus(t("status.pasted", { count: text.length }), "info");
  } catch (error) {
    setStatus(t("status.pasteFailed", { message: messageOf(error) }), "error");
  }
}

/** 浏览器/输入法触发的原生 paste 事件：内容已经在事件里，不必再读剪贴板。 */
async function handlePaste(event: ClipboardEvent, view: Pick<SessionView, "terminal" | "summary">): Promise<void> {
  const text = event.clipboardData?.getData("text");
  if (!text) return;
  event.preventDefault();
  await pasteText(text, view);
}

/**
 * 复制选区。
 *
 * 两条路都试：先是浏览器的 clipboard API，失败再走宿主的 `clipboard.write`
 * 能力（面板通道）。为什么需要回退：面板页是 `sandbox: true` 的沙箱文档，
 * Chromium 会以「页面未被用户激活 / 文档未聚焦」为由拒绝
 * `navigator.clipboard.writeText` —— 而 Ctrl+C 恰恰容易发生在焦点刚从别处
 * 回来的那一刻。只试第一条时，用户看到的就是「选了内容按 Ctrl+C 却没反应」。
 */
async function copySelection(terminal: TerminalHandle, view?: Pick<SessionView, "summary">): Promise<void> {
  const selection = terminal.selection();
  if (!selection) {
    setStatus(t("status.nothingSelected"), "info");
    return;
  }

  let viaBrowser = false;
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(selection);
      viaBrowser = true;
    }
  } catch {
    // Sandboxed views may not expose the Clipboard API or may reject the write.
  }
  if (!viaBrowser) {
    const viaHost = await writeClipboardViaHost(selection);
    if (!viaHost) {
      setStatus(t("status.copyFailed"), "error");
      return;
    }
  }

  // 复制后清掉选中：否则紧接着的 Ctrl+C 会再次复制而不是发送 ^C。
  terminal.clearSelection();
  setStatus(t("status.copied", { count: selection.length }), "info");
  void view;
}

/** 走宿主剪贴板能力；宿主没有声明权限时返回 false。 */
async function writeClipboardViaHost(text: string): Promise<boolean> {
  try {
    const result = (await bridge().invoke("clipboard.writeText", { text })) as { ok?: unknown } | null;
    return result?.ok === true;
  } catch {
    return false;
  }
}

/* ── 主题 ─────────────────────────────────────────────────────────────── */

/**
 * 启动时同步一次：先问宿主当前外观，拿不到就退回系统配色偏好。
 *
 * 这一步不能省：`appearance:changed` 只在**变化时**推送，插件视图第一次打开
 * 时不会收到它，只能主动问一次，否则浅色主题下会先闪一下深色。
 */
async function syncAppearance(): Promise<void> {
  try {
    const appearance = (await api.getAppearance()) as Appearance | null;
    applyAppearance(appearance);
  } catch {
    applyAppearance(null);
  }
}

/** 把一次外观信号落到 DOM 与所有终端上。 */
function applyAppearance(appearance: Appearance | null): void {
  const base = resolveBase(appearance);
  applyBase(base, appearance);
  for (const view of state.sessions.values()) {
    view.terminal?.setBaseTheme(base);
  }
}

/* ── 会话动作 ─────────────────────────────────────────────────────────── */

async function openLocal(): Promise<void> {
  // 防重入：宿主给面板调用的超时是 30s，pty 拉起在慢机器上可能要几秒。
  // 这期间用户会再点一次，两次都成功就会凭空多出一个终端 —— 看起来像是
  // 「第一次点击没反应」。直接忽略重复点击，并立即给出进行中的反馈。
  if (openingLocal) return;
  openingLocal = true;
  setStatus(t("status.openingLocal"), "info");
  const view = state.activeId ? state.sessions.get(state.activeId) : null;
  const cols = view?.terminal?.term.cols ?? 100;
  const rows = view?.terminal?.term.rows ?? 30;
  try {
    const result: OpenSessionResult = await api.openSession({ kind: "local", cols, rows });
    lastOpenError = "";
    addSession(result);
    await activate(result.session.id);
  } catch (error) {
    // 会话可能已经建出来（addSession 之后 activate 才失败）。这时必须把视图里的
    // 残留清掉并重画，否则下一次点击会激活一个「有标签、没终端」的会话，
    // activate 走 else 分支只把 element 显示出来 —— 用户看到的就是点了没反应。
    lastOpenError = messageOf(error);
    rollbackFailedSession();
    setStatus(t("status.openLocalFailed", { message: lastOpenError }), "error");
    if ((error as BridgeError).code === "LIMIT") showLimitHint();
  } finally {
    openingLocal = false;
    // 失败后必须重画一次：空状态里要带上原因，否则界面上什么都没有变化。
    if (lastOpenError && state.sessions.size === 0) renderEmptyState();
  }
}

/**
 * 打开失败后把视图恢复到一致状态。
 *
 * 条件是「这个会话有标签但没有终端」：真正的会话如果已经跑起来，terminal 一定
 * 存在，不能误杀。清完之后重画标签并回到空状态或最后一个可用会话。
 */
function rollbackFailedSession(): void {
  let changed = false;
  for (const [id, entry] of state.sessions) {
    // 有 terminal 或 stream 说明它是真正建立过的会话，不能误杀。
    if (entry.terminal || entry.stream) continue;
    entry.element?.remove();
    state.sessions.delete(id);
    if (state.activeId === id) state.activeId = null;
    changed = true;
  }
  if (!changed) return;
  renderTabs();
  if (state.sessions.size === 0) {
    renderEmptyState();
    return;
  }
  const next = [...state.sessions.keys()].pop();
  if (next && !state.activeId) void activate(next);
}

async function connectProfile(profileId: string): Promise<void> {
  const view = state.activeId ? state.sessions.get(state.activeId) : null;
  const cols = view?.terminal?.term.cols ?? 100;
  const rows = view?.terminal?.term.rows ?? 30;
  hideOverlay();
  setStatus(t("status.connecting"), "info");
  try {
    const result = await api.openSession({ kind: "ssh", cols, rows, profileId });
    addSession(result);
    await activate(result.session.id);
  } catch (error) {
    const message = messageOf(error);
    if (/host key/i.test(message)) {
      // 指纹变化是硬拒绝；只有「未知主机」才走确认流程。
      // 而「等待确认超时」也落在这里 —— 说清楚是没确认，而不是连接坏了。
      setStatus(
        /was not accepted|not been accepted/i.test(message) ? t("status.hostKeyDeclined") : message,
        "error",
      );
      return;
    }
    setStatus(t("status.openSshFailed", { message }), "error");
  }
}

function addSession(result: OpenSessionResult): void {
  // 防御：这里曾经把一个**失败响应**当成成功建出会话。
  //
  // 面板桥的失败形状是 `{ok:false, code, message}`，正常情况下 bridge.call()
  // 会把它转成异常。但只要有任意一层包装把它当成普通返回值（例如宿主把
  // 结果再套一层 `{ok:true, value}`），`result.session` 就是 undefined ——
  // 于是视图画出一个标题为 "local"、cwd 未知、状态 closed、点它什么也不发生
  // 的标签。宁可在这里报错，也不要画出一个假的会话。
  const session = result?.session;
  if (!session || typeof session.id !== "string" || !session.id) {
    const failure = result as unknown as { code?: string; message?: string } | undefined;
    // code 来自后端，可能是任意字符串；BridgeError 只接受已知码，统一归到 INTERNAL。
    throw new BridgeError(
      "INTERNAL",
      failure?.message || "the terminal plugin did not return a session",
    );
  }
  state.sessions.set(session.id, {
    summary: session,
    terminal: null,
    stream: null,
    status: "connecting",
    unread: false,
    element: null,
  });
  renderTabs();
}

async function closeSession(id: string): Promise<void> {
  const view = state.sessions.get(id);
  if (!view) return;
  view.stream?.stop();
  view.terminal?.dispose();
  state.sessions.delete(id);
  if (state.activeId === id) {
    state.activeId = null;
    const next = state.sessions.keys().next();
    if (!next.done) await activate(next.value);
    else {
      // 一个都不剩了：告诉宿主「没有活动会话」，别让它继续指向刚关掉的那个。
      void api.setActiveSession(null).catch(() => undefined);
      renderEmptyState();
    }
  }
  renderTabs();
  try {
    await api.closeSession(id);
  } catch (error) {
    setStatus(t("status.closeFailed", { message: messageOf(error) }), "error");
  }
}

/** 进入就地重命名：标签标题变成输入框。 */
function beginRename(id: string): void {
  if (!state.sessions.has(id)) return;
  state.renamingId = id;
  renderTabs();
}

function cancelRename(): void {
  if (state.renamingId === null) return;
  state.renamingId = null;
  renderTabs();
}

/** 提交重命名；空值视为取消。 */
async function commitRename(id: string, value: string): Promise<void> {
  if (state.renamingId !== id) return;
  const view = state.sessions.get(id);
  state.renamingId = null;
  const next = value.trim();
  if (!view || !next || next === view.summary.title) {
    renderTabs();
    return;
  }
  try {
    const { session } = await api.renameSession(id, next);
    view.summary = session;
    renderTabs();
  } catch (error) {
    setStatus(t("status.renameFailed", { message: messageOf(error) }), "error");
    renderTabs();
  }
}

/* ── 状态条 ───────────────────────────────────────────────────────────── */

function setStatus(message: string, level: "info" | "error"): void {
  if (!dom.status) return;
  dom.status.dataset.level = level;
  dom.status.textContent = message;
}

function updateStatusLine(view: SessionView): void {
  if (!dom.status) return;
  const label =
    view.status === "live"
      ? t("status.streaming")
      : view.status === "polling"
        ? t("status.polling")
        : view.status;
  const detail = view.detail ? ` — ${view.detail}` : "";
  dom.status.dataset.level = view.status === "error" ? "error" : "info";
  const kind = view.summary.kind === "local" ? t("common.local") : t("common.ssh");
  dom.status.textContent =
    `${t("status.sessionLine", { kind, title: view.summary.title, state: label })}${detail}` +
    ` · seq ${view.stream?.lastSeq ?? view.summary.seq}`;
}

function showLimitHint(): void {
  // 真实上限来自设置；这里读当前值而不是写死 8。
  const limit = state.settings?.maxSessions ?? 8;
  // 不能用 window.alert：宿主 webview 会把它拦掉（Electron 里默认禁用同步
  // 对话框），用户看到的就是「点了新建什么也没发生」。状态条是宿主保证
  // 可用的那条反馈通道，和别的错误走同一条路径。
  setStatus(t("status.limitReached", { limit }), "error");
}

/* ── 覆盖层 ───────────────────────────────────────────────────────────── */

type OverlayKind = "picker" | "profileForm" | "hostkey";

/**
 * 浮层的三种用途：
 *   picker      → 「＋ 新建 SSH」的连接选择器：只列主机，点一下就连。
 *   profileForm → 新增/编辑主机档案的表单（主机列表本身在面板里，不是浮层）。
 *   hostkey     → 首次连接某主机时的指纹确认。
 */
function showOverlay(kind: OverlayKind): void {
  const overlay = dom.overlay;
  if (!overlay) return;
  state.overlay = kind;
  overlay.hidden = false;
  overlay.innerHTML = "";

  const panel = document.createElement("div");
  panel.className = "term-panel";
  overlay.append(panel);

  const close = button("", t("common.closeHint"), () => hideOverlay());
  close.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  close.className = "term-btn term-panel-close";
  close.setAttribute("aria-label", t("common.close"));
  panel.append(close);

  if (kind === "picker") {
    const heading = document.createElement("h2");
    heading.textContent = t("profiles.title");
    panel.append(heading);
    const list = document.createElement("div");
    panel.append(list);
    void refreshProfiles().then(() => {
      renderSshPicker(list, state.profiles, (id) => void connectProfile(id));
    });
    return;
  }
  if (kind === "profileForm") {
    renderProfileFormPanel(panel);
    return;
  }
  renderHostKeyPrompt(panel);
}

/** 新增/编辑主机：表单放在浮层里，主机列表本身在面板内。 */
function openProfileOverlay(profile: SshProfile | null): void {
  pendingProfileEdit = profile;
  showOverlay("profileForm");
}

/** 浮层里的主机表单：提交成功后刷新面板里的列表。 */
function renderProfileFormPanel(panel: HTMLElement): void {
  const form = buildProfileForm(pendingProfileEdit, {
    onCancel: () => hideOverlay(),
    onSubmit: async (payload, existing) => {
      try {
        await api.saveProfile(payload);
        await refreshProfiles();
        hideOverlay();
        await renderHostsPane();
        setStatus(existing ? t("status.hostUpdated") : t("status.hostSaved"), "info");
      } catch (error) {
        setStatus(t("status.hostSaveFailed", { message: messageOf(error) }), "error");
      }
    },
    onReveal: async (profileId, kind) => {
      try {
        const result = await api.revealSecret(profileId, kind);
        return result.value;
      } catch (error) {
        setStatus(t("status.revealFailed", { message: messageOf(error) }), "error");
        return null;
      }
    },
  });
  fillGroupSuggestions(
    form,
    state.profiles.map((item) => item.group ?? ""),
  );
  panel.append(form);
}

async function deleteProfile(id: string): Promise<void> {
  const target = state.profiles.find((profile) => profile.id === id);
  if (!window.confirm(t("status.deleteConfirm", { name: target?.name ?? id }))) return;
  try {
    await api.deleteProfile(id);
    await refreshProfiles();
    await renderHostsPane();
    setStatus(t("status.hostDeleted"), "info");
  } catch (error) {
    setStatus(t("status.hostDeleteFailed", { message: messageOf(error) }), "error");
  }
}

async function testProfile(
  id: string,
  report: (message: string, level: "info" | "error") => void = setStatus,
): Promise<void> {
  report(t("status.testStarting"), "info");
  try {
    const result = await api.testProfile(id);
    report(t("status.testOk", { host: result.host, port: result.port, ms: result.elapsedMs }), "info");
  } catch (error) {
    report(t("status.testFailed", { message: messageOf(error) }), "error");
  }
}

async function refreshProfiles(): Promise<void> {
  try {
    const { profiles } = await api.listProfiles();
    state.profiles = profiles;
  } catch (error) {
    setStatus(t("status.hostsLoadFailed", { message: messageOf(error) }), "error");
  }
}

function hideOverlay(): void {
  if (!dom.overlay) return;
  dom.overlay.hidden = true;
  dom.overlay.innerHTML = "";
  state.overlay = null;
}

/* ── 覆盖层：主机指纹 ─────────────────────────────────────────────────── */

function renderHostKeyPrompt(panel: HTMLElement): void {
  const pending = state.pendingHostKey;
  const heading = document.createElement("h2");
  heading.textContent = pending
    ? t("hostkey.title", { host: `${pending.host}:${pending.port}` })
    : t("hostkey.titleGeneric");
  panel.append(heading);

  const body = document.createElement("p");
  body.className = "term-hint";
  body.textContent = pending
    ? t("hostkey.body", { fingerprint: pending.fingerprint })
    : t("hostkey.none");
  panel.append(body);

  if (pending) {
    const actions = document.createElement("div");
    actions.className = "term-form-actions";
    actions.append(
      button(t("hostkey.trust"), t("hostkey.trustHint"), async () => {
        await api.decideHostKey({ ...pending, accepted: true }).catch(() => undefined);
        hideOverlay();
      }),
      button(t("hostkey.cancel"), t("hostkey.cancelHint"), async () => {
        await api.decideHostKey({ ...pending, accepted: false }).catch(() => undefined);
        hideOverlay();
      }),
    );
    panel.append(actions);
  }
}

/**
 * 从会话摘要里发现「有连接的指纹在等我确认」，并把确认框弹出来。
 *
 * ── 这是首次连接能成功的关键 ──────────────────────────────────────────────
 * 插件侧在 `onHostKey` 里挂起等待，而**那次 invoke 正被它自己堵着**；宿主又没有
 * 插件→面板的推送。以前的代码只声明了 `state.pendingHostKey`，全仓库没有一处给它
 * 赋值，于是：确认框永不出现 → 20 秒后插件按拒绝处理 → 首次连接某台主机必然失败。
 *
 * 现在由 1 秒的会话同步来发现它：摘要里出现 `hostKeyPending` 就弹框；用户点按钮
 * 后 `api.decideHostKey` 唤醒等待中的连接，摘要随之清空，框自动收起。
 */
function applyPendingHostKey(sessions: SessionSummary[]): void {
  const pending = sessions.find((session) => session.hostKeyPending)?.hostKeyPending ?? null;

  if (!pending) {
    // 连接已经被处理（确认/取消/超时）：收起框，别留一个点不动的确认。
    if (state.pendingHostKey && state.overlay === "hostkey") hideOverlay();
    state.pendingHostKey = null;
    return;
  }

  const same =
    state.pendingHostKey?.host === pending.host &&
    state.pendingHostKey?.port === pending.port &&
    state.pendingHostKey?.fingerprint === pending.fingerprint;
  if (same && state.overlay === "hostkey") return;

  state.pendingHostKey = { ...pending };
  // 别抢用户正在填的档案表单：等他关掉再弹。
  if (state.overlay === "profileForm") return;
  showOverlay("hostkey");
}

/* ── 主机面板（面板内，与终端平级）────────────────────────────────────── */

/**
 * 清掉 stage 里「不属于会话终端」的内容（空状态、主机面板）。
 *
 * 只删这些，**永远不要**整体清空 stage：会话的终端元素就在其中，摘掉它们
 * 会让切换标签后的面板变成空白。
 */
function clearNonSessionPanels(stage: HTMLElement): void {
  for (const child of [...stage.children]) {
    if ((child as HTMLElement).dataset.role === "surface") continue;
    child.remove();
  }
}

/** 切回终端面板：显示当前会话的终端，其余保持隐藏。 */
function showTerminalPane(): void {
  state.pane = "terminal";
  if (dom.hostsBtn) delete dom.hostsBtn.dataset.active;
  markSettingsButton(false);
  const stage = dom.stage;
  if (stage) {
    clearNonSessionPanels(stage);
    for (const view of state.sessions.values()) {
      if (view.element) view.element.hidden = view.summary.id !== state.activeId;
    }
  }
  if (state.sessions.size === 0) {
    renderEmptyState();
    return;
  }
  const active = state.activeId ? state.sessions.get(state.activeId) : null;
  active?.terminal?.focus();
  const size = active?.terminal?.refit();
  if (size && active) void api.resize(active.summary.id, size.cols, size.rows).catch(() => undefined);
}

/** 「主机」固定入口：再点一次回到终端（同一个按钮来回切，不额外占位置）。 */
function showHostsPane(): void {
  if (state.pane === "hosts") {
    showTerminalPane();
    return;
  }
  state.pane = "hosts";
  markSettingsButton(false);
  if (dom.hostsBtn) dom.hostsBtn.dataset.active = "true";
  void renderHostsPane();
}

/**
 * 画主机面板。
 *
 * 结构：**顶部固定一条工具条**（添加主机 + 计数），下面是可滚动的主机列表。
 * 「添加主机」始终在列表上方、不随滚动移动 —— 主机很多时也不用先滚到顶部。
 * 新增/编辑的表单走浮层，所以列表本身永远只读、不会跳动。
 */
async function renderHostsPane(): Promise<void> {
  const stage = dom.stage;
  if (!stage) return;
  await refreshProfiles();
  if (state.pane !== "hosts") return;

  // 隐藏所有终端（保留它们），删掉其它非终端内容。
  for (const child of [...stage.children]) {
    const element = child as HTMLElement;
    if (element.dataset.role === "surface") element.hidden = true;
    else element.remove();
  }

  const pane = document.createElement("div");
  pane.className = "term-hosts";
  pane.dataset.role = "hosts";

  const bar = document.createElement("div");
  bar.className = "term-hosts-bar";
  const add = button(`＋ ${t("hosts.add")}`, t("hosts.addHint"), () => openProfileOverlay(null));
  add.dataset.primary = "true";
  const count = document.createElement("span");
  count.className = "term-hosts-count";
  count.textContent = t("hosts.count", { count: state.profiles.length });
  bar.append(add, count);

  const listHost = document.createElement("div");
  listHost.className = "term-hosts-list";

  const handlers: ProfilePanelHandlers = {
    onConnect: (id) => void connectProfile(id),
    onEdit: (profile) => openProfileOverlay(profile),
    onDelete: (id) => void deleteProfile(id),
    onTest: (id) => void testProfile(id),
    status: (message, level) => setStatus(message, level),
  };
  // 表单在浮层里；这里给一个游离节点只为满足渲染函数的签名。
  renderProfileManager(listHost, state.profiles, handlers, document.createElement("div"));

  pane.append(bar, listHost);
  stage.append(pane);
}
/* ── 小工具 ───────────────────────────────────────────────────────────── */

/* ── 设置面板（面板内，与终端平级）────────────────────────────────────── */

/**
 * 设置面板：插件设置的**唯一**入口。
 *
 * 为什么在面板里而不是宿主的「插件 - 设置」页：那一页的下拉选项只能来自
 * manifest 的静态声明（安装时固定），列不出「这台机器上装了哪些等宽字体」。
 * 字体是本机事实，只能由插件枚举 + 视图实测，所以设置回到能拿到这份数据的
 * 地方（宿主的设置页因此不再声明这些键，见 manifest.ts）。
 *
 * 交互：改动即保存（用 `change` 而不是 `input` —— 后者会在每次按键都写一次
 * 盘），保存后立刻作用到已经打开的终端，不用为了看效果去新开标签。
 */
let fontFamiliesCache: string[] | null = null;

async function showSettingsPane(): Promise<void> {
  if (state.pane === "settings") {
    // 同一个按钮来回切，与「主机」一致。
    showTerminalPane();
    return;
  }
  state.pane = "settings";
  if (dom.hostsBtn) delete dom.hostsBtn.dataset.active;
  markSettingsButton(true);
  await renderSettingsPane();
}

async function renderSettingsPane(): Promise<void> {
  const stage = dom.stage;
  if (!stage) return;
  // 现读一次：设置的真源是宿主侧的 settings.json，面板可能被切走再切回。
  try {
    const fresh = await api.getSettings();
    state.settings = fresh.settings;
    state.defaults = fresh.defaults ?? null;
    state.secretStore = fresh.secretStore;
  } catch {
    /* 读不到就用手上这份，至少能渲染出来 */
  }
  if (state.pane !== "settings") return;

  for (const child of [...stage.children]) {
    const element = child as HTMLElement;
    if (element.dataset.role === "surface") element.hidden = true;
    else element.remove();
  }

  const pane = document.createElement("div");
  pane.className = "term-hosts term-settings";
  pane.dataset.role = "settings";

  const bar = document.createElement("div");
  bar.className = "term-hosts-bar";
  const heading = document.createElement("strong");
  heading.textContent = t("settings.title");
  const note = document.createElement("span");
  note.className = "term-hosts-count";
  note.textContent = state.secretStore ? t("settings.secretStore", { detail: state.secretStore.detail }) : "";
  bar.append(heading, note);

  const body = document.createElement("div");
  body.className = "term-hosts-list";
  body.append(buildSettingsForm());

  pane.append(bar, body);
  stage.append(pane);
}

function buildSettingsForm(): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "term-form term-settings-form";
  form.addEventListener("submit", (event) => event.preventDefault());
  const settings = state.settings;
  resetButtons.clear();

  const save = (patch: Partial<AppSettings>): Promise<void> =>
    api
      .setSettings(patch)
      .then((result) => {
        state.settings = result.settings;
        if (result.defaults) state.defaults = result.defaults;
        // 值变了，各行的「重置」可用状态也得跟着变（否则刚改完还是灰的）。
        refreshResetButtons();
        applySettingsToTerminals(result.settings, patch);
        setStatus(t("status.settingsSaved"), "info");
      })
      .catch((error) => {
        setStatus(t("status.settingsFailed", { message: messageOf(error) }), "error");
      });

  /**
   * 重置为默认值。
   *
   * 走的是**同一条**保存路径（默认值就是一次普通写入），写完整块重画：只把控件
   * 的值改回去而不同步「重置按钮现在该不该可用」，界面很快就会自相矛盾。
   */
  const resetTo = (key: keyof AppSettings): void => {
    const defaults = state.defaults;
    if (!defaults) return;
    void save({ [key]: defaults[key] } as Partial<AppSettings>).then(() => renderSettingsPane());
  };
  const reset = (key: keyof AppSettings) => ({
    key,
    run: () => resetTo(key),
    disabled: isAtDefault(key),
  });

  /* ── 启动 ─────────────────────────────────────────────────────────── */
  form.append(settingsSection(t("settings.sectionStartup")));

  const shell = document.createElement("input");
  shell.name = "defaultShell";
  shell.spellcheck = false;
  shell.value = settings?.defaultShell ?? "";
  shell.placeholder = t("settings.defaultShellPlaceholder");
  shell.addEventListener("change", () => void save({ defaultShell: shell.value.trim() }));
  form.append(settingsRow(t("settings.defaultShell"), shell, { reset: reset("defaultShell") }));

  const cwd = document.createElement("select");
  cwd.name = "defaultCwdMode";
  appendOptions(
    cwd,
    [
      { value: "workspace", label: t("settings.cwdWorkspace") },
      { value: "home", label: t("settings.cwdHome") },
    ],
    settings?.defaultCwdMode ?? "workspace",
  );
  cwd.addEventListener("change", () => void save({ defaultCwdMode: cwd.value as AppSettings["defaultCwdMode"] }));
  form.append(settingsRow(t("settings.cwdMode"), cwd, { reset: reset("defaultCwdMode") }));

  /* ── 外观 ─────────────────────────────────────────────────────────── */
  form.append(settingsSection(t("settings.sectionAppearance")));

  // 字体：下拉单选，选项来自宿主（font-list 的 monospace 集合）。
  const font = document.createElement("select");
  font.name = "fontFamily";
  font.dataset.role = "fontSelect";
  font.addEventListener("change", () => void save({ fontFamily: font.value }));
  const fontNote = document.createElement("span");
  fontNote.className = "term-hint";
  fontNote.textContent = t("settings.fontLoading");
  const fontRow = settingsRow(t("settings.fontFamily"), font, { reset: reset("fontFamily") });
  fontRow.querySelector(".term-settings-field")?.append(fontNote);
  form.append(fontRow);
  void fillFontOptions(font, fontNote);

  const size = numberField(settings?.fontSize ?? DEFAULT_SETTINGS.fontSize, 8, 28, 1, String(DEFAULT_SETTINGS.fontSize));
  size.addEventListener("change", () => void save({ fontSize: clampNumber(size.value, 8, 28, DEFAULT_SETTINGS.fontSize) }));
  form.append(settingsRow(t("settings.fontSize"), size, { reset: reset("fontSize"), name: "fontSize" }));

  /* ── 会话 ─────────────────────────────────────────────────────────── */
  form.append(settingsSection(t("settings.sectionSessions")));

  const scrollback = numberField(settings?.scrollback ?? 5000, 100, 50_000, 100, "5000");
  scrollback.addEventListener("change", () =>
    void save({ scrollback: clampNumber(scrollback.value, 100, 50_000, 5000) }),
  );
  form.append(settingsRow(t("settings.scrollback"), scrollback, { reset: reset("scrollback"), name: "scrollback" }));

  // 缓冲用 MiB 展示：让用户填 2097152 这种数字没有意义，写 2 才是他想的。
  const bufferMiB = Math.round(((settings?.bufferBytes ?? 2 * 1024 * 1024) / (1024 * 1024)) * 4) / 4;
  const buffer = numberField(bufferMiB, 0.25, 8, 0.25, "2");
  buffer.addEventListener("change", () =>
    void save({ bufferBytes: Math.round(clampNumber(buffer.value, 0.25, 8, 2) * 1024 * 1024) }),
  );
  form.append(
    settingsRow(t("settings.bufferMiB"), buffer, { hint: t("settings.bufferHint"), reset: reset("bufferBytes"), name: "bufferMiB" }),
  );

  const maxSessions = numberField(settings?.maxSessions ?? 8, 1, 16, 1, "8");
  maxSessions.addEventListener("change", () => void save({ maxSessions: clampNumber(maxSessions.value, 1, 16, 8) }));
  form.append(settingsRow(t("settings.maxSessions"), maxSessions, { reset: reset("maxSessions"), name: "maxSessions" }));

  /* ── 交互 ─────────────────────────────────────────────────────────── */
  form.append(settingsSection(t("settings.sectionInteraction")));
  form.append(
    settingsToggle(t("settings.cursorBlink"), settings?.cursorBlink ?? true, (checked) =>
      void save({ cursorBlink: checked }),
    {
      reset: reset("cursorBlink"),
    }),
    settingsToggle(t("settings.confirmPaste"), settings?.confirmMultilinePaste ?? true, (checked) =>
      void save({ confirmMultilinePaste: checked }),
    {
      reset: reset("confirmMultilinePaste"),
    }),
  );

  /* ── 网络 ─────────────────────────────────────────────────────────── */
  form.append(settingsSection(t("settings.sectionNetwork")));
  form.append(
    settingsToggle(t("settings.relay"), settings?.relayEnabled ?? true, (checked) => void save({ relayEnabled: checked }), {
      reset: reset("relayEnabled"),
    }),
  );

  const keepalive = numberField(settings?.sshKeepaliveSeconds ?? 20, 5, 300, 1, "20");
  keepalive.addEventListener("change", () =>
    void save({ sshKeepaliveSeconds: clampNumber(keepalive.value, 5, 300, 20) }),
  );
  form.append(settingsRow(t("settings.keepalive"), keepalive, { reset: reset("sshKeepaliveSeconds"), name: "sshKeepaliveSeconds" }));

  return form;
}

/** 当前值是否已经是默认值（决定「重置」按钮是否可点）。 */
function isAtDefault(key: keyof AppSettings): boolean {
  const current = state.settings;
  const defaults = state.defaults;
  if (!current || !defaults) return true;
  return current[key] === defaults[key];
}
function settingsSection(title: string): HTMLElement {
  const heading = document.createElement("h3");
  heading.className = "term-settings-section";
  heading.textContent = title;
  return heading;
}

interface SettingsRowOptions {
  /** 控件下方的一行弱提示。 */
  hint?: string;
  /** 传了就显示「重置为默认值」按钮；`disabled` 表示当前已经是默认值。 */
  reset?: { key: keyof AppSettings; run: () => void; disabled: boolean };
  /** 表单字段名：让控件在 DOM 里可被识别（测试与无障碍都受益）。 */
  name?: string;
}

/**
 * 一行设置：左边标题、中间控件、右边重置。
 *
 * 用同一套网格排所有行（包括勾选项），标题才会像用户要求的那样统一左对齐；
 * 勾选框放在控件那一列的最左侧，和其它控件起点对齐。
 */
function settingsRow(label: string, control: HTMLElement, options: SettingsRowOptions = {}): HTMLElement {
  const row = document.createElement("div");
  row.className = "term-settings-row";

  const text = document.createElement("label");
  text.className = "term-settings-label";
  text.textContent = label;
  // 点标题也能编辑：给控件补一个 id 并让 label 指向它。
  if (!control.id) control.id = `term-set-${++settingsRowSeq}`;
  text.htmlFor = control.id;

  if (options.name && control instanceof HTMLInputElement) control.name = options.name;
  const field = document.createElement("div");
  field.className = "term-settings-field";
  field.append(control);
  if (options.hint) {
    const note = document.createElement("span");
    note.className = "term-hint";
    note.textContent = options.hint;
    field.append(note);
  }

  row.append(text, field);

  if (options.reset) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "term-settings-reset";
    reset.dataset.role = "reset";
    reset.title = t("settings.reset");
    reset.setAttribute("aria-label", t("settings.reset"));
    reset.disabled = options.reset.disabled;
    reset.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">' +
      '<path d="M3.2 6.2A5 5 0 1 1 3 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M3.1 2.6v3.9h3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>";
    reset.addEventListener("click", options.reset.run);
    resetButtons.set(options.reset.key, reset);
    row.append(reset);
  }

  return row;
}

/** 「重置」按钮要能点到标题这一列之外，给它一个稳定的自增 id 就够了。 */
let settingsRowSeq = 0;

/** 每个设置项的重置按钮：保存之后要按新的当前值刷新它们的可用状态。 */
const resetButtons = new Map<keyof AppSettings, HTMLButtonElement>();

function refreshResetButtons(): void {
  for (const [key, button] of resetButtons) button.disabled = isAtDefault(key);
}
/**
 * 勾选项也是「标题在左、控件在右」的一行 —— 与其它设置项同一套网格，
 * 这样整列标题才是齐的（此前它是一整条 label，标题跑到勾选框右边去了）。
 */
function settingsToggle(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  options: SettingsRowOptions = {},
): HTMLElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "term-settings-switch";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return settingsRow(label, input, options);
}
function numberField(value: number, min: number, max: number, step: number, placeholder: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.placeholder = placeholder;
  return input;
}

function appendOptions(
  select: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
  selected?: string,
): void {
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  if (selected !== undefined) select.value = selected;
}

function clampNumber(value: string | number, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/**
 * 字体下拉的内容。
 *
 * 只列**实测等宽**的已装字体，另加两项：默认（交给浏览器的 monospace 回退），
 * 以及已保存但这次没通过检测的族名 —— 后者仍然要出现，否则下拉会静默跳回
 * 「默认」，用户会以为自己的设置被重置了。
 */
async function fillFontOptions(select: HTMLSelectElement, note: HTMLElement): Promise<void> {
  const current = state.settings?.fontFamily ?? "";
  select.replaceChildren();
  appendOptions(select, [{ value: "", label: t("settings.fontDefault") }]);
  let families: string[] = [];
  try {
    families = await loadMonospaceFamilies();
  } catch (error) {
    note.textContent = t("status.fontsFailed", { message: messageOf(error) });
    select.value = "";
    return;
  }
  if (current && !families.includes(current)) {
    appendOptions(select, [{ value: current, label: current }]);
  }
  appendOptions(select, families.map((family) => ({ value: family, label: family })));
  select.value = current;
  note.textContent = t("settings.fontsCount", { count: families.length });
}

async function loadMonospaceFamilies(): Promise<string[]> {
  if (fontFamiliesCache) return fontFamiliesCache;
  const { families, monospace } = await api.listFonts();
  // 首选 font-list 的 monospace 标记；它整片为空时（见 host/fonts.ts 的说明）
  // 才退回 canvas 实测。两条路都不会给出「这台机器上没装」的字体。
  const resolved = monospace.length > 0 ? monospace : pickMonospaceFamilies(families, canvasMeasure());
  fontFamiliesCache = resolved;
  return resolved;
}

/**
 * 应用「从外部来的」设置（模型工具改的 / 宿主推来的）。
 *
 * 为什么面板自己改不需要这一步：面板改完会**本地下发**给每个终端。而模型走的是
 * 宿主的 `applySettings`，视图这边完全不知情 —— 已建好的终端各自持有一份字体
 * 快照，`state.settings` 也是旧的，所以以前必须重开面板（或重启宿主）才看见效果。
 */
function applyRemoteSettings(next: unknown): void {
  if (!next || typeof next !== "object") return;
  const incoming = next as AppSettings;
  if (settingsSignature(incoming) === settingsSignature(state.settings)) return;

  const previous = state.settings;
  state.settings = incoming;
  if (
    previous &&
    (previous.fontFamily !== incoming.fontFamily ||
      previous.fontSize !== incoming.fontSize ||
      previous.cursorBlink !== incoming.cursorBlink)
  ) {
    applySettingsToTerminals(incoming, {
      fontFamily: incoming.fontFamily,
      fontSize: incoming.fontSize,
      cursorBlink: incoming.cursorBlink,
    });
  }
  // 面板正开着设置页：重画一次让输入框显示新值。但用户正在某个控件里操作时
  // 绝不重画 —— 那会把焦点和正在输入的内容一起冲掉（每次保存都会触发这里）。
  const editing = document.activeElement instanceof Element && document.activeElement.closest(".term-settings-form");
  if (state.pane === "settings" && !editing) void renderSettingsPane();
  setStatus(t("status.settingsSaved"), "info");
}

/** 比较用的签名：字段顺序由宿主的 sanitizeSettings 固定，可以直接比字符串。 */
function settingsSignature(value: AppSettings | null): string {
  return value ? JSON.stringify(value) : "";
}

/** 兜底轮询：回环流被用户关掉或被策略拦时，设置变更也能在 5 秒内到位。 */
function startSettingsPoll(): void {
  window.setInterval(() => {
    if (document.hidden) return;
    void api
      .getSettings()
      .then((result) => {
        if (settingsSignature(result.settings) === settingsSignature(state.settings)) return;
        if (result.defaults) state.defaults = result.defaults;
        applyRemoteSettings(result.settings);
      })
      .catch(() => undefined);
  }, 5000);
}
/** 字体/光标类改动立刻作用到已打开的终端（xterm 的 options 是可变的）。 */
function applySettingsToTerminals(settings: AppSettings, patch: Partial<AppSettings>): void {
  if (!("fontFamily" in patch) && !("fontSize" in patch) && !("cursorBlink" in patch)) return;
  for (const view of state.sessions.values()) {
    view.terminal?.applyOptions({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorBlink: settings.cursorBlink,
    });
    const size = view.terminal?.refit();
    if (size) void api.resize(view.summary.id, size.cols, size.rows).catch(() => undefined);
  }
}

/**
 * 「设置」固定入口按钮。
 *
 * 用选择器取而不是在 `dom` 里多存一份引用：入口按钮的选中态只有「设置」和
 * 「主机」两处会动，而为它加一个 dom 字段就得改 dom 的类型声明 —— 那几行
 * 都带联合类型，改动面比这里的收益大。
 */
function settingsButton(): HTMLButtonElement | null {
  return dom.root ? dom.root.querySelector<HTMLButtonElement>('button[data-fixed="settings"]') : null;
}

function markSettingsButton(active: boolean): void {
  const button = settingsButton();
  if (!button) return;
  if (active) button.dataset.active = "true";
  else delete button.dataset.active;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "term-btn";
  el.textContent = label;
  el.title = title;
  el.addEventListener("click", onClick);
  return el;
}

/** 文案进 innerHTML 前转义：词表是本地的，但错误信息里可能带用户数据。 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 供排障使用：宿主 devtools 里可以直接看视图状态。 */
(window as unknown as { piTerminal?: unknown }).piTerminal = { state, api };

/* 入口：DOM 就绪后启动；失败时把错误显示在页面上而不是只打控制台。 */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void start());
} else {
  void start();
}

async function start(): Promise<void> {
  try {
    await boot();
  } catch (error) {
    const root = document.getElementById("root");
    if (root) {
      root.innerHTML = "";
      const box = document.createElement("div");
      box.className = "term-empty";
      box.textContent = `The terminal view could not start: ${messageOf(error)}`;
      root.append(box);
    }
    console.error("[pi-terminal] view failed to start", error);
  }
}
