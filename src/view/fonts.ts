/**
 * 等宽字体的兜底实测（视图侧）。
 *
 * 什么时候用：宿主给的 `monospace` 标记为空时。font-list 在部分 Windows 组合上
 * 会把那段判定静默吞掉（实测 262 个字体一个都没标），此时只用标记就等于
 * 「字体下拉里只有默认」。所以这里回到最朴素的判据 —— **渲染宽度**：
 *
 *   1. 装了没有：先用一个肯定不存在的族名量一次，得到「回退宽度」。某族名量出来
 *      与它完全相同 ⇒ 浏览器静默回退了 ⇒ 这个字体没装。
 *   2. 是不是等宽：比例字体里 `i` 与 `M` 必然不同宽，等宽字体必然相同。
 *
 * 测量函数是注入的，所以这段逻辑可以脱离浏览器单测。
 */

export type Measure = (font: string, text: string) => number;

const WIDE = "MMMMMMMMMM";
const NARROW = "iiiiiiiiii";
/** 与默认终端字号一致，避免无谓的 hinting 差异。 */
const PROBE_SIZE = 14;
const MISSING_FAMILY = "__pi_terminal_missing_family__";

/** 从已装族名里挑出等宽的，保持输入顺序并去重。 */
export function pickMonospaceFamilies(families: string[], measure: Measure): string[] {
  const fallbackWidth = measure(cssFont(MISSING_FAMILY), WIDE);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    const name = family.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    const font = cssFont(name);
    const wide = measure(font, WIDE);
    if (wide <= 0) continue;
    // 与「不存在的族」量到同一个宽度 ⇒ 这台机器上没装它。
    if (Math.abs(wide - fallbackWidth) < 0.01) continue;
    const narrow = measure(font, NARROW);
    // 允许 0.5px 的舍入误差：某些字体在整数像素网格上有微小的累加偏差。
    if (Math.abs(wide - narrow) <= 0.5) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

function cssFont(family: string): string {
  return `${PROBE_SIZE}px "${family.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * 默认测量实现：一个 1×1 的离屏 canvas。
 *
 * 每个候选族名要量两次，canvas 与 context 因此只建一次。
 */
export function canvasMeasure(): Measure {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) {
    // 没有 canvas：退化成「测不出」，调用方拿到空列表，下拉只剩「默认」——
    // 比给出一个错误的候选列表好。
    return () => 0;
  }
  return (font: string, text: string) => {
    context.font = font;
    return context.measureText(text).width;
  };
}
