/**
 * 系统字体枚举（基于 font-list）。
 *
 * ── 为什么用 font-list ─────────────────────────────────────────────────────
 * 「哪些字体是等宽的」跨平台差异极大：Windows 要过 WPF 的 `SystemFontFamilies`，
 * macOS 要一个原生 helper，Linux 要走 `fc-list`。font-list 把三条路都做完，
 * `getFonts2()` 直接给出 `{ familyName, monospace }`。
 *
 * ── 为什么还要返回「全部族名」──────────────────────────────────────────────
 * 实测（Windows 11 + PowerShell 5.1）：`getFonts2()` 的 `monospace` 标记可能
 * **恒为 false** —— 它那段判定塞在一次性 `-command` 里，异常被静默吞掉，于是
 * 262 个字体里一个等宽都没标。直接把空集合丢给界面，字体下拉就只剩「默认」。
 * 因此这里同时返回全部族名，由视图在「标记为空」时用 canvas 实测兜底
 * （见 view/fonts.ts 的 pickMonospaceFamilies）。
 *
 * ── 为什么它不被打进 main.js ──────────────────────────────────────────────
 * font-list 要在**自己目录里**找运行时资源：win32 回退路径用
 * `libs/win32/fonts.vbs`，darwin 要执行 `libs/darwin/fontlist` 这个原生二进制。
 * esbuild 内联 JS 后 `__dirname` 变成插件根，两样都会找不到。所以它作为运行时
 * 依赖放在顶层 `vendor/font-list/`（宿主安装器只跳过 `node_modules` 与 `.git`），
 * 运行时按绝对路径 require，它的 `__dirname` 仍指向自己。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** font-list `getFonts2()` 的条目（只列我们用到的字段）。 */
export interface FontInfo {
  name: string;
  familyName: string;
  postScriptName: string;
  weight: string;
  style: string;
  width: string;
  /** font-list 的等宽判定。可能整个平台恒为 false，见文件头。 */
  monospace: boolean;
}

export interface FontFamilies {
  /** 所有已安装的族名（去重、排序）：视图兜底实测时用。 */
  families: string[];
  /** font-list 明确标记为等宽的族名（首选来源）。 */
  monospace: string[];
}

interface FontListModule {
  getFonts2(options?: { disableQuoting?: boolean }): Promise<FontInfo[]>;
}

let cached: FontFamilies | null = null;
let inflight: Promise<FontFamilies> | null = null;

/**
 * 已安装字体：全部族名 + font-list 标记的等宽子集。
 *
 * 失败时返回空集合而不抛错：字体下拉是设置页里的一个选项，拿不到就只显示
 * 「默认」，不该让整页红一片。空结果不缓存，下次进设置会再试一次。
 */
export async function listInstalledFamilies(): Promise<FontFamilies> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const fontList = loadFontList();
    if (!fontList) return { families: [], monospace: [] };
    return normalizeFamilies(await fontList.getFonts2({ disableQuoting: true }));
  })().catch(() => ({ families: [], monospace: [] }));
  try {
    const result = await inflight;
    if (result.families.length > 0) cached = result;
    return result;
  } finally {
    inflight = null;
  }
}

/** 纯函数：归一化 font-list 的结果（导出供单测）。 */
export function normalizeFamilies(fonts: FontInfo[]): FontFamilies {
  const all = new Map<string, string>();
  const mono = new Map<string, string>();
  for (const font of fonts ?? []) {
    if (!font) continue;
    const name = String(font.familyName ?? "").trim();
    if (!name || name.length > 64) continue;
    const key = name.toLowerCase();
    if (!all.has(key)) all.set(key, name);
    if (font.monospace === true && !mono.has(key)) mono.set(key, name);
  }
  const sort = (values: Iterable<string>): string[] =>
    [...values].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  return { families: sort(all.values()), monospace: sort(mono.values()) };
}

/** 供测试/排障：清掉缓存。 */
export function resetFontCache(): void {
  cached = null;
}

/**
 * 载入 font-list。
 *
 * 两个候选：插件里 vendor 的那份（正式安装形态），以及普通模块解析（从源码仓库
 * 直接跑时 node_modules 就在旁边）。这里必须用**变量**调用 require —— 不能让
 * esbuild 把它内联进来，一旦内联，font-list 就找不到自己的平台资源。
 */
function loadFontList(): FontListModule | null {
  const vendored = join(__dirname, "vendor", "font-list");
  const specifier = existsSync(join(vendored, "index.js")) ? vendored : "font-list";
  try {
    const requireFromHere = createRequire(__filename);
    return requireFromHere(specifier) as FontListModule;
  } catch (error) {
    console.warn("[pi-terminal] font-list is unavailable:", error instanceof Error ? error.message : error);
    return null;
  }
}
