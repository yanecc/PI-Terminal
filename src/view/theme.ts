/**
 * 主题同步。
 *
 * 为什么需要这一层（这是最初版本的缺陷）：宿主**不会**把它的 CSS 变量注入
 * 插件页 —— 插件页是独立的沙箱文档，`--bg` / `--fg` 在那里根本不存在，之前
 * 的样式与 xterm 主题因此永远回落到硬编码的深色值，浅色主题下必然对不上。
 *
 * 宿主真正提供的是两条明确信号：
 *   · `app.getAppearance()`（可 invoke）返回 `{ base: "light" | "dark" | "system", … }`
 *   · `pluginBridge.on("appearance:changed", …)` 推送同一个结构
 * 所以本模块把这些信号翻译成：
 *   1. `<html data-base="light|dark">` —— 样式表据此切换整套变量；
 *   2. `<html data-theme-preference="…">` —— 仅在排障时需要知道是跟随系统还是显式主题；
 *   3. 一组**本插件自己定义**的完整调色板（不依赖宿主变量），交给 xterm 与 CSS。
 *
 * `base === "system"` 时用 `prefers-color-scheme` 判定 —— 与宿主自己
 * （builtinWindowBackground / applyAppearance）用的是同一条规则，因此两边一致。
 */

export type BaseTheme = "light" | "dark";

export interface Appearance {
  /** 宿主给的原始偏好（可能是 `system` 或 `plugin:<id>`）。 */
  theme?: string;
  base?: string;
  /**
   * 应用当前语言（BCP-47）。宿主把它和外观放在同一个载荷里下发，
   * 所以插件不需要为语言另开一条通道。
   */
  locale?: string;
}

/** 解析宿主给出的 base；`system`/未知值一律按系统配色偏好决定。 */
export function resolveBase(appearance: Appearance | null | undefined): BaseTheme {
  const base = appearance?.base;
  if (base === "light" || base === "dark") return base;
  return prefersLight() ? "light" : "dark";
}

function prefersLight(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}

/** 把 base 写到 <html> 上：样式表与 xterm 都读它。 */
export function applyBase(base: BaseTheme, appearance?: Appearance | null): void {
  const root = document.documentElement;
  root.dataset.base = base;
  // 让浏览器原生控件（滚动条、表单控件、自动填充）也跟着切。
  root.style.colorScheme = base;
  if (appearance?.theme) root.dataset.themePreference = appearance.theme;
}

/** 当前生效的 base（读 DOM，保证与样式表看到的是同一个值）。 */
export function currentBase(): BaseTheme {
  return document.documentElement.dataset.base === "light" ? "light" : "dark";
}

interface Palette {
  /** xterm 的 ITheme 允许额外键；保留索引签名让它可直接赋值。 */
  [key: string]: string | undefined;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * xterm 调色板。
 *
 * 与 CSS 里的 `--term-*` 是同一套色：深色版按宿主暗色面板调，浅色版单独
 * 选过（直接把深色版反相会让黄/青在浅底上不可读）。ANSI 16 色用常见的
 * Solarized/One 折中值，红绿对比在两种底色下都够。
 */
const DARK: Palette = {
  background: "#181818",
  foreground: "#e6e6e6",
  cursor: "#ffffff",
  cursorAccent: "#181818",
  selectionBackground: "rgba(255,255,255,0.20)",
  black: "#3b3b3b",
  red: "#ff6764",
  green: "#8fd694",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#dcdfe4",
  brightBlack: "#7a8290",
  brightRed: "#ff8f8a",
  brightGreen: "#a8e6a3",
  brightYellow: "#f0d197",
  brightBlue: "#7fc4ff",
  brightMagenta: "#d99bea",
  brightCyan: "#7fd0d9",
  brightWhite: "#ffffff",
};

const LIGHT: Palette = {
  background: "#fafafa",
  foreground: "#1a1c1f",
  cursor: "#1a1c1f",
  cursorAccent: "#fafafa",
  selectionBackground: "rgba(26,28,31,0.16)",
  black: "#1a1c1f",
  red: "#c1272d",
  green: "#2f7d32",
  yellow: "#8a6d1f",
  blue: "#1f5fa8",
  magenta: "#8b3f9e",
  cyan: "#0f6f77",
  white: "#5d5d5d",
  brightBlack: "#767676",
  brightRed: "#e02e2a",
  brightGreen: "#3f9a44",
  brightYellow: "#a8842a",
  brightBlue: "#2f77c9",
  brightMagenta: "#a552b9",
  brightCyan: "#16828b",
  brightWhite: "#1a1c1f",
};

export function paletteFor(base: BaseTheme): Palette {
  return base === "light" ? { ...LIGHT } : { ...DARK };
}

/** 当前 base 对应的 xterm 主题。 */
export function currentTheme(): Palette {
  return paletteFor(currentBase());
}
