/**
 * 把视图侧打成供真实浏览器测试用的 IIFE bundle。
 *
 * 为什么是 IIFE 而不是 ESM：chrome-devtools-mcp 的浏览器没有网络，
 * 只能开 `file://` 页面，而 `file://` 下 ES module 的 import 会被 CORS 拦掉。
 * IIFE 挂到 `window.__view`，普通 `<script>` 标签在两种协议下都能加载。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, "src/view/main.ts")],
  outfile: join(root, "test/view-behavior.bundle.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "__view",
  target: "chrome120",
  sourcemap: false,
  logLevel: "warning",
});
console.log("[test] view bundle ready (IIFE → window.__view)");
