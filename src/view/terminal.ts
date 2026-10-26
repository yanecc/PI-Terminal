/**
 * xterm 封装（xterm.js 6，**默认 DOM 渲染器**）。
 *
 * 为什么坚持 DOM 渲染器：宿主的面板是 `WebContentsView` + 沙箱页，WebGL 在
 * 某些显卡/远程桌面下会静默失败并回退到极慢的 canvas；DOM 渲染器在文本量
 * 正常时足够快，且不会因为 GPU 进程被禁用而变慢或黑屏。要换也只是换一个
 * addon，因此这里把「创建终端」收成一个函数。
 *
 * 这件事上唯一的硬约束是：**写入必须带回调**，回调用作背压信号。
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { currentTheme, paletteFor, type BaseTheme } from "./theme.js";

export interface TerminalHandle {
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** 挂到 DOM 并完成首次尺寸计算。 */
  mount(container: HTMLElement): void;
  /** 写入并等待渲染完成（背压）。 */
  write(bytes: Uint8Array): Promise<void>;
  /** 重新测量并返回新的 cols/rows；无变化时返回 null。 */
  refit(): { cols: number; rows: number } | null;
  focus(): void;
  /** 有选中文字时为 true —— 决定 Ctrl+C 是复制还是发给 shell。 */
  hasSelection(): boolean;
  /** 选中文字（无选中时为空串）。 */
  selection(): string;
  /** 清掉选中：复制之后调用，避免同一次 Ctrl+C 既复制又发送。 */
  clearSelection(): void;
  /** 跟随主题切换（xterm 的 theme 是可变选项，改它不需要重建终端）。 */
  setBaseTheme(base: BaseTheme): void;
  /** 运行期改字体/光标：xterm 的 options 是可变的，改完重新 fit 即可。 */
  applyOptions(next: { fontSize?: number; fontFamily?: string; cursorBlink?: boolean }): void;
  dispose(): void;
}

export interface TerminalOptions {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  scrollback: number;
  onData: (data: string) => void;
  /** 选区变化：上层据此更新 Ctrl+C 的语义提示（可选）。 */
  onSelectionChange?: (hasSelection: boolean) => void;
  /**
   * 允许上层在 xterm 处理之前截获按键。
   *
   * 必须走 `attachCustomKeyEventHandler`：在宿主元素上挂 `keydown` 捕获监听
   * 已经晚了 —— xterm 自己就监听 textarea 的 keydown，会把 Ctrl+C 直接映射成
   * `` 交给 shell。返回 false 才表示「这个键不给终端处理」。
   */
  shouldHandleKey?: (event: KeyboardEvent) => boolean;
}

export function createTerminal(options: TerminalOptions): TerminalHandle {
  const term = new Terminal({
    // 6.x 默认就是 DOM 渲染器；这里不注册任何 renderer addon，保持这个默认。
    convertEol: false,
    cursorBlink: options.cursorBlink,
    fontFamily: options.fontFamily || undefined,
    fontSize: options.fontSize,
    lineHeight: 1.25,
    letterSpacing: 0,
    scrollback: options.scrollback,
    // 允许 readline/ssh 的粘贴保护生效，也让 bracketed paste 端到端可用。
    ignoreBracketedPasteMode: false,
    allowTransparency: false,
    allowProposedApi: false,
    theme: currentTheme(),
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternal(uri)));

  term.onData(options.onData);

  // 注册到 xterm 的按键入口（返回 false = 终端不处理该键）。
  if (options.shouldHandleKey) {
    const handler = options.shouldHandleKey;
    term.attachCustomKeyEventHandler((event) => (event.type === "keydown" ? handler(event) : true));
  }

  if (options.onSelectionChange) {
    term.onSelectionChange(() => options.onSelectionChange?.(term.hasSelection()));
  }

  let mounted = false;
  let lastCols = 0;
  let lastRows = 0;

  return {
    term,
    fit,

    mount(container) {
      if (mounted) return;
      term.open(container);
      mounted = true;
      lastCols = term.cols;
      lastRows = term.rows;
      // 打开后再 fit 一次：容器在挂载前尺寸可能是 0。
      requestAnimationFrame(() => fit.fit());
      term.focus();
    },

    write(bytes) {
      return new Promise<void>((resolve) => {
        // 回调在数据进入渲染队列后触发；这就是背压点。
        term.write(bytes, () => resolve());
      });
    },

    refit() {
      if (!mounted) return null;
      const before = { cols: term.cols, rows: term.rows };
      try {
        fit.fit();
      } catch {
        return null;
      }
      if (term.cols === before.cols && term.rows === before.rows) return null;
      if (term.cols === lastCols && term.rows === lastRows) return null;
      lastCols = term.cols;
      lastRows = term.rows;
      return { cols: term.cols, rows: term.rows };
    },

    focus() {
      term.focus();
    },

    hasSelection() {
      return term.hasSelection();
    },

    selection() {
      return term.getSelection();
    },

    clearSelection() {
      term.clearSelection();
    },

    setBaseTheme(base) {
      // 只改 theme 选项：xterm 会重绘现有内容，滚动缓冲与正在跑的程序都不受影响。
      term.options.theme = paletteFor(base);
    },

    applyOptions(next) {
      // 只改选项，不重建 terminal：重建会丢掉滚动缓冲并杀掉正在跑的程序。
      if (typeof next.fontSize === "number") term.options.fontSize = next.fontSize;
      if (typeof next.fontFamily === "string") term.options.fontFamily = next.fontFamily || undefined;
      if (typeof next.cursorBlink === "boolean") term.options.cursorBlink = next.cursorBlink;
      // 字号变了 ⇒ 每个字符格子的宽高都变了，必须重新量一次网格。
      try {
        fit.fit();
      } catch {
        /* 容器还没有尺寸 */
      }
    },

    dispose() {
      try {
        term.dispose();
      } catch {
        /* 已经销毁 */
      }
    },
  };
}

/**
 * 兼容导出：早期版本从这里读主题。
 * 现在颜色由 theme.ts 决定（宿主不向插件页注入 CSS 变量，读变量永远拿到空值）。
 */
export function readTheme(): Record<string, string | undefined> {
  return currentTheme();
}

/** 链接点击交给宿主打开：视图没有 `shell.openExternal`，用 pluginBridge 也不合适。 */
function openExternal(uri: string): void {
  try {
    // 面板页里 window.open 被宿主拦截并转交 shell.openExternal（只放行 http/https）。
    window.open(uri, "_blank", "noopener,noreferrer");
  } catch {
    /* 被拦就静默；用户仍可手动复制链接 */
  }
}
