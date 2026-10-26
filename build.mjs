/**
 * 构建脚本：把 src/ 编译成 PI-Desktop 可加载的插件产物。
 *
 * 产物形状（与 pi.file-manager 等内置插件一致）：
 *   main.js            宿主 sidecar 里加载的插件主进程（CommonJS）
 *   manifest.json      src/manifest.ts 生成的清单（单一真源）
 *   views/index.html   工作面板视图入口
 *   views/assets/view.js   视图 bundle（IIFE，xterm 内联）
 *   views/assets/xterm.css xterm 样式
 *
 * 视图必须打成单文件 IIFE：面板页是 file:// 的沙箱页，esbuild 的 code
 * splitting / ESM 相对导入在 file:// 下没有必要也更易碎。
 */
import { build, context } from "esbuild";
import { createRequire } from "node:module";
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(root, "views");
const assetsDir = join(viewsDir, "assets");
const watching = process.argv.includes("--watch");

/** 把 xterm 的 CSS 从包里取出来，附在视图样式前面。 */
const require = createRequire(import.meta.url);

async function copyXtermCss() {
  const cssPath = require.resolve("@xterm/xterm/css/xterm.css");
  const css = await readFile(cssPath, "utf8");
  await writeFile(join(assetsDir, "xterm.css"), css, "utf8");
}

async function emitManifest() {
  // 清单由 TS 模块生成，避免手写 JSON 与代码漂移。
  const mod = await import("./dist-manifest.mjs").catch(() => null);
  if (!mod) throw new Error("dist-manifest.mjs missing: run the manifest bundle first");
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(mod.manifest, null, 2)}\n`, "utf8");
}

async function run() {
  await rm(viewsDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });

  const hostOptions = {
    entryPoints: [join(root, "src/host/index.ts")],
    outfile: join(root, "main.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // 宿主的 sidecar 是 Node 环境：node: 内置模块保持外部，其余依赖必须自带。
    // ssh2 有两个**可选**原生加速依赖（cpu-features / nan）。它们只是 key
    // 派生加速，缺失时 ssh2 会走纯 JS 实现，因此保持外部并让 Node 在运行时
    // 解析失败即可 —— 打包进来反而会增加一次原生模块加载失败的风险。
    external: ["node:*", "electron", "cpu-features", "nan"],
    // 源码里用 ".js" 后缀导入 TypeScript 文件（NodeNext 的正确写法），
    // esbuild 需要显式告知这一步重写。
    resolveExtensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
    // fancy-pty 从自己的 path.join 解析 helper，__dirname 必须是真实目录。
    sourcemap: false,
    logLevel: "info",
    legalComments: "none",
  };

  const manifestOptions = {
    entryPoints: [join(root, "src/manifest.ts")],
    outfile: join(root, "dist-manifest.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "info",
  };

  const viewOptions = {
    entryPoints: [join(root, "src/view/main.ts")],
    outfile: join(assetsDir, "view.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: false,
    minify: !watching,
    logLevel: "info",
    loader: { ".css": "text", ".ttf": "file" },
  };

  await copyFile(join(root, "src/view/index.html"), join(viewsDir, "index.html"));
  await copyFile(join(root, "src/view/styles.css"), join(assetsDir, "view.css"));

  if (watching) {
    const ctxs = await Promise.all([context(hostOptions), context(viewOptions), context(manifestOptions)]);
    await copyXtermCss();
    await emitManifest();
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[build] watching…");
    return;
  }

  await Promise.all([build(hostOptions), build(viewOptions), build(manifestOptions)]);
  await copyXtermCss();
  await emitManifest();
  console.log("[build] done");
}

await run();
