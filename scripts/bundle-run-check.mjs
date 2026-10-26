/**
 * 证明**用户机器上的那棵插件树**能跑起来（而不只是仓库能跑）。
 *
 * ── 为什么需要这个脚本 ────────────────────────────────────────────────────
 * 其它检查都在仓库根目录跑：那里有完整的 node_modules。所以「产物里少了什么」
 * 在仓库里永远测不出来 —— 缺的文件会被仓库的 node_modules 悄悄补上，检查照样
 * 全绿，装到用户机器上才炸。
 *
 * 更关键的是：PI-Desktop 的安装器（host-core 的 `copy_dir_filtered`）会**跳过
 * `.git` 与 `node_modules`**，所以包里即使带了 node_modules，到用户机器上也不
 * 存在。这个脚本因此做三件事：
 *   1. 自己解析 .piplug 解到空临时目录（不依赖 tar/unzip）；
 *   2. **模拟安装器**：删掉 `.git` / `node_modules`，得到用户真正拿到的那棵树；
 *   3. 在那棵树上验证：视图资源齐全、依赖确实内联在 main.js（没有裸 require
 *      到不存在的包）、六个平台 helper 都在，最后交给宿主真实的 sidecar 驱动
 *      init 与 panel.invoke。
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginPath = process.argv[2] ?? join(root, "dist", "pi-terminal-1.0.0.piplug");
const hostSidecar = process.argv[3];

const results = [];
const ok = (m) => { results.push(true); console.log(`OK  ${m}`); };
const fail = (m) => { results.push(false); console.log(`ERR ${m}`); };

/* ── 1. 解包 ──────────────────────────────────────────────────────────── */
/**
 * 极简 zip 读取器：只处理我们自己的产物（store 或 deflate、无加密、无 zip64）。
 * 自己解析而不是调 tar/unzip，是因为这两个工具在部分机器上不存在，而脚本里
 * 「有没有装某个外部工具」的分支正是最容易腐坏的部分。
 */
async function readZip(path) {
  const buf = await readFile(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive (no EOCD)");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    // 本地头的 extra 长度与中央目录里的**不一定相同**，必须各读各的。
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    out.push({ name, method, raw: buf.subarray(dataStart, dataStart + compSize) });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const entries = await readZip(pluginPath);
const workDir = await mkdtemp(join(tmpdir(), "piplug-extract-"));
for (const entry of entries) {
  const target = join(workDir, entry.name);
  if (entry.name.endsWith("/")) { await mkdir(target, { recursive: true }); continue; }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, entry.method === 8 ? inflateRawSync(entry.raw) : entry.raw);
}
ok(`extracted ${entries.length} entries into an empty temp directory`);

/*
 * ── 模拟宿主的安装器 ────────────────────────────────────────────────────
 * `host-core` 的 `copy_dir_filtered` 会跳过 `.git` 和 `node_modules`：
 *
 *     if name_str == ".git" || name_str == "node_modules" { continue; }
 *
 * 所以「用户机器上真正得到的树」= 解包结果减去这两个目录。这里照它做一遍，
 * 之后的所有检查都跑在这棵树上 —— 任何依赖 node_modules 的东西都会立刻暴露，
 * 而不是等到用户装完才发现 SSH 起不来。
 */
for (const skipped of [".git", "node_modules"]) {
  await rm(join(workDir, skipped), { recursive: true, force: true });
}
ok("simulated the installer: .git / node_modules removed (this is what the user gets)");

/* ── 2. 视图资源（xterm 已内联，不再是独立包）────────────────────────── */
for (const rel of ["views/index.html", "views/assets/view.js", "views/assets/view.css", "views/assets/xterm.css"]) {
  try { await stat(join(workDir, rel)); ok(`present after extract: ${rel}`); }
  catch { fail(`missing after extract: ${rel}`); }
}
const viewJs = await readFile(join(workDir, "views", "assets", "view.js"), "utf8");
if (viewJs.includes("_bufferService") || viewJs.includes("BufferService")) ok("view.js carries the inlined xterm core");
else fail("view.js does not contain xterm — inlining broke");
if (!/require\(["']@xterm/.test(viewJs)) ok("view.js does not require @xterm at runtime");
else fail("view.js still requires @xterm at runtime");

/* -- 2b. all six platform pty helpers must be inside the package --
 * A .piplug is ONE cross-platform bundle: the same file installs on Windows,
 * macOS and Linux. On the build machine only its own helper ever executes, so
 * "one platform is missing" can never fail locally -- it must be asserted.
 */
const ALL_HELPER_PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
let helperCount = 0;
for (const platform of ALL_HELPER_PLATFORMS) {
  const suffix = platform.startsWith("win32") ? "fancy-pty-helper.exe" : "fancy-pty-helper";
  const rel = `bin/${platform}/${suffix}`;
  try {
    const info = await stat(join(workDir, rel));
    if (info.size < 1024) fail(`${rel} is suspiciously small (${info.size} bytes)`);
    else helperCount += 1;
  } catch {
    fail(`missing after extract: ${rel} - this package would not run on ${platform}`);
  }
}
if (helperCount === ALL_HELPER_PLATFORMS.length) ok(`all ${helperCount} platform pty helpers are in the package`);

/* ── 3. 依赖必须内联在真入口里（因为 node_modules 到不了用户机器）── */
/*
 * 宿主安装器不让 node_modules 通过，所以这里不能靠「解包目录里能 require 到
 * ssh2」来证明什么 —— 那种检查只在 node_modules 被打进包时才成立，而那种包
 * 装上去是坏的。判据必须是静态的：真入口里不许有这些包的裸 require，而且
 * 要真的含它们的实现。
 *
 * 注意入口已经在打包时拆成两个文件（见 package.mjs 的「入口拆分」注释）：
 *   main.js   一行的 shim：module.exports = require("./core.pi")
 *   core.pi   真正的 bundle
 * 所以所有内容判据都必须跑在 core.pi 上 —— 拿 shim 去查当然查不到 ssh2。
 */
const shimText = await readFile(join(workDir, "main.js"), "utf8");
if (shimText.trim() === 'module.exports = require("./core.pi");') {
  ok("main.js is the core.pi shim");
} else {
  fail(`main.js is not the expected shim: ${JSON.stringify(shimText.slice(0, 120))}`);
}
const mainJs = await readFile(join(workDir, "core.pi"), "utf8");
const MUST_BE_BUNDLED = [
  "ssh2",
  "ssh2-sftp-client",
  "concat-stream",
  "asn1",
  "bcrypt-pbkdf",
  "safer-buffer",
  "tweetnacl",
  "@particle-academy/fancy-pty",
];
const leaked = MUST_BE_BUNDLED.filter((pkg) => {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`require\\((["'])(?:\\.\\./)*(?:node_modules/)?${escaped}\\1\\)`).test(mainJs);
});
if (leaked.length === 0) ok("core.pi has no runtime require() of any bundled package");
else fail(`core.pi still requires ${leaked.join(", ")} - the installer skips node_modules, so they would be missing`);

// 内联证据：SSH 协议常量与 SFTP 客户端符号都应该在真入口 core.pi 里。
for (const [marker, what] of [
  ["SSH-2.0-", "the ssh2 protocol banner"],
  ["diffie-hellman", "ssh2 key exchange"],
  ["fastPut", "the SFTP client"],
]) {
  if (mainJs.includes(marker)) ok(`core.pi carries ${what}`);
  else fail(`core.pi does not contain ${what} (${marker}) - that dependency was probably left external`);
}

/*
 * 只允许这几种外部 require：Node 内建模块，以及 ssh2 的**可选**原生加速
 * （cpu-features / nan，缺失时 ssh2 自动走纯 JS）。其余任何裸包名都意味着
 * 装到用户机器上会 MODULE_NOT_FOUND。
 */
const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "crypto", "dns", "events", "fs", "http", "https",
  "net", "os", "path", "stream", "tls", "url", "util", "zlib", "module", "process",
]);
const ALLOWED_EXTERNAL = new Set(["electron", "cpu-features", "nan"]);
const bareRequires = new Set();
for (const match of mainJs.matchAll(/require\((["'])([^"'./][^"']*)\1\)/g)) bareRequires.add(match[2]);
const unexpected = [...bareRequires].filter(
  (name) => !NODE_BUILTINS.has(name) && !ALLOWED_EXTERNAL.has(name) && !name.startsWith("node:"),
);
if (unexpected.length === 0) ok("the only external requires are Node builtins and optional native addons");
else fail(`main.js requires packages that will not exist at runtime: ${unexpected.join(", ")}`);

/* ── 4. 交给宿主 sidecar 真正加载一次 ────────────────────────────────── */
/*
 * 复用 host-load-check.mjs：它铺好 process.parentPort，用宿主真实的
 * plugin-host-process.js 驱动 init（命令/工具注册）与 panel.invoke（term.ping）。
 * 这里只是把「插件根」换成解包目录。
 */
const hostCheck = join(root, "scripts", "host-load-check.mjs");
// `host-load-check.mjs` 的 argv[2] 是 sidecar 路径、argv[3] 是插件根。
// 不给 sidecar 时传它自己的默认路径（与 host-load-check.mjs 顶部的常量保持一致），
// 这样直接 `node scripts/bundle-run-check.mjs` 也能跑。
const DEFAULT_HOST_SIDECAR =
  "C:/Users/Sunrise/.pi-desktop/scratch/2218932a-3feb-41e2-8a3e-3c85c635db3e/full/out/main/plugin-host-process.js";
const args = [hostCheck, hostSidecar || DEFAULT_HOST_SIDECAR, workDir];
const run = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
run.stdout.on("data", (c) => { stdout += c; });
run.stderr.on("data", (c) => { stderr += c; });
const code = await new Promise((resolve) => run.on("close", resolve));
const tail = stdout.trim().split("\n").slice(-6).join("\n");
if (code === 0) ok(`the host sidecar loaded the extracted bundle (exit 0)`);
else fail(`the host sidecar could not load the extracted bundle (exit ${code})\n${tail}\n${stderr.slice(-400)}`);
for (const line of stdout.split("\n")) {
  if (/^commands registered:|^tools registered:|^host init ok|term\.ping via host bridge:|^\[host-load\] plugin path:/.test(line.trim())) {
    console.log(`    ${line.trim()}`);
  }
}

/* ── 5. 收尾 ─────────────────────────────────────────────────────────── */
await rm(workDir, { recursive: true, force: true }).catch(() => undefined);

const failed = results.filter((v) => !v).length;
console.log(failed ? `\nEXTRACTED BUNDLE CHECK FAILED (${failed})` : "\nEXTRACTED BUNDLE CHECK OK");
process.exit(failed ? 1 : 0);
