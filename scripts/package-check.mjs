/**
 * 打包产物自检：确认 .piplug 是一个**能被 Windows 正常解包**的 zip。
 *
 * 这一项是为了防住一个已经发生过的交付事故：早期版本用 PowerShell 的
 * `Compress-Archive` 打包，条目名里是反斜杠（`node_modules\@xterm\...`）。
 * zip 规范要求正斜杠，Windows 解包器建目录时会撞上已存在的同名项，报
 * `os error 183 (ERROR_ALREADY_EXISTS)`，用户看到「安装失败：当文件已存在时，
 * 无法创建该文件」。
 *
 * 所以这里断言的是**结构**，不是「命令成功」：
 *   · 无重复条目、无大小写冲突（Windows 不区分大小写）；
 *   · 无反斜杠分隔符；
 *   · 条目名全部是 ASCII（避免解包器的编码分支）；
 *   · 目录条目以 `/` 结尾，且目录不与同名文件冲突；
 *   · 关键文件齐全（main.js / manifest.json / views/index.html / 本平台 helper）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const file = process.argv[2] ?? pickLatest();
const bytes = readFileSync(file);

function pickLatest() {
  const names = readdirSync("dist").filter((name) => name.endsWith(".piplug"));
  if (!names.length) {
    console.error("no .piplug in dist/: run `npm run package` first");
    process.exit(2);
  }
  names.sort();
  return `dist/${names[names.length - 1]}`;
}
const problems = [];
const report = (message) => {
  problems.push(message);
  console.log(`✖ ${message}`);
};
const ok = (message) => console.log(`✔ ${message}`);

/* ── 解析中央目录 ─────────────────────────────────────────────────────── */
let eocd = -1;
for (let i = bytes.length - 22; i >= 0; i -= 1) {
  if (bytes.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  report("not a zip file: EOCD not found");
  process.exit(1);
}

const declared = bytes.readUInt16LE(eocd + 10);
const cdOffset = bytes.readUInt32LE(eocd + 16);
const entries = [];
let p = cdOffset;
while (p < bytes.length && bytes.readUInt32LE(p) === 0x02014b50) {
  const flags = bytes.readUInt16LE(p + 8);
  const nameLen = bytes.readUInt16LE(p + 28);
  const extraLen = bytes.readUInt16LE(p + 30);
  const commentLen = bytes.readUInt16LE(p + 32);
  const name = bytes.subarray(p + 46, p + 46 + nameLen).toString("utf8");
  // method 必须记下来：宿主只接受 store（0），压缩过的包会被 PLUGIN_INVALID 拒绝。
  const method = bytes.readUInt16LE(p + 10);
  // bsdtar（Windows 的 `tar.exe -cf … -C <stage> .`）会给每个条目加 `./` 前缀，
  // 解包器会把它当「当前目录」忽略掉。这里统一剥掉，后续断言才有意义。
  const normalized = name.startsWith("./") ? name.slice(2) : name;
  entries.push({
    name: normalized,
    isDir: normalized.endsWith("/"),
    utf8: (flags & 0x800) !== 0,
    method,
    // 外部属性高 16 位是 Unix 权限位；用来断言 helper 带可执行位。
    mode: bytes.readUInt32LE(p + 38) >>> 16,
  });
  p += 46 + nameLen + extraLen + commentLen;
}

ok(`${file}: ${entries.length} entries, ${(statSync(file).size / 1024 / 1024).toFixed(2)} MiB`);

if (entries.length !== declared) report(`EOCD declares ${declared} entries but ${entries.length} were parsed`);

/* ── 结构断言 ─────────────────────────────────────────────────────────── */
const seen = new Map();
const seenLower = new Map();
for (const entry of entries) {
  if (seen.has(entry.name)) report(`duplicate entry: ${entry.name}`);
  seen.set(entry.name, entry);

  const lower = entry.name.toLowerCase();
  if (seenLower.has(lower) && seenLower.get(lower) !== entry.name) {
    report(`case-insensitive clash: ${seenLower.get(lower)} vs ${entry.name}`);
  }
  seenLower.set(lower, entry.name);

  if (entry.name.includes("\\")) report(`backslash in entry name: ${entry.name}`);
  // 非 ASCII 名字才必须置 UTF-8 标志；纯 ASCII 名字不置是合规的（zip 规范只在
  // 需要时才置位）。旧校验器要求所有条目都置位，会把 bsdtar 的正常产物误判。
  const nonAscii = /[^\x20-\x7e]/.test(entry.name);
  if (nonAscii && !entry.utf8) report(`non-ASCII name without UTF-8 flag: ${entry.name}`);
}

const dirs = new Set(entries.filter((e) => e.isDir).map((e) => e.name.slice(0, -1).toLowerCase()));
for (const entry of entries) {
  if (!entry.isDir && dirs.has(entry.name.toLowerCase())) {
    report(`entry exists both as a directory and a file: ${entry.name}`);
  }
}
// 宿主解包器只支持 store；压缩过（method=8）的包会在安装时被拒。
const compressed = entries.filter((entry) => entry.method !== 0);
if (compressed.length) {
  report(`${compressed.length} entries are compressed (host accepts store only), e.g. ${compressed[0].name}`);
} else {
  ok(`all ${entries.length} entries are store-compressed (required by the host unzipper)`);
}

if (!problems.length) ok("no duplicate / case-clashing / backslash / non-ASCII entries");

/* ── 关键文件 ─────────────────────────────────────────────────────────── */
const names = new Set(entries.map((e) => e.name));
const required = [
  "main.js",
  "core.pi",
  "manifest.json",
  "views/index.html",
  // 视图侧：xterm 已被 esbuild 内联进 view.js，样式单独抽出。
  // 所以这里要的是**产物**，不是 node_modules 里的 xterm。
  "views/assets/view.js",
  "views/assets/view.css",
  "views/assets/xterm.css",
  // 这里**不能**再要求 node_modules/**：宿主安装器会整目录跳过它，
  // 依赖只能内联在 main.js 里（见 package.mjs 的 MUST_BE_BUNDLED 断言）。
  "vendor/font-list/index.js",
  "vendor/font-list/libs/darwin/fontlist",
];
for (const name of required) {
  if (names.has(name)) ok(`present: ${name}`);
  else report(`missing: ${name}`);
}

/*
 * pty helper：**六个平台必须全在**顶层 bin/ 里。
 *
 * （1）为什么必须在顶层：PI-Desktop 的安装器把包内容拷进安装目录时，会跳过
 *      名为 `node_modules` 的目录，所以 node_modules 里的 helper 到不了用户
 *      机器。顶层 `bin/` 是唯一可靠的落点。
 * （2）为什么必须六个平台齐全：`.piplug` 是**一个**跨平台分发包。只验证
 *      「构建机能跑」远远不够 —— 包里少一个平台，那个平台装上去本地终端就
 *      起不来，而这个问题在构建机上根本看不出来（本机恰好有自己那份）。
 */
const ALL_HELPER_PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
for (const platform of ALL_HELPER_PLATFORMS) {
  const suffix = platform.startsWith("win32") ? "fancy-pty-helper.exe" : "fancy-pty-helper";
  const entry = `bin/${platform}/${suffix}`;
  if (names.has(entry)) ok(`present (installable): ${entry}`);
  else report(`missing from bin/: ${entry} — this is a cross-platform bundle, every platform needs its helper`);
}
for (const entry of entries) {
  if (entry.isDir || entry.name.endsWith(".exe")) continue;
  if (!/^bin\/[^/]+\/fancy-pty-helper$/.test(entry.name)) continue;
  // Unix helper 在包里就必须带可执行位：解包器照抄权限位，缺 +x 会在
  // macOS/Linux 上直接 EACCES —— 同样是在 Windows 构建机上测不出来的问题。
  if ((entry.mode & 0o111) === 0) report(`helper has no execute bit inside the archive: ${entry.name}`);
}
if (!problems.length) ok("all six platform helpers are executable in the archive");

/* ── 必须**不在**包里的东西 ─────────────────────────────────────────────
 * 1. **整个 `node_modules` 都不能进包。** 宿主安装器（`install.rs` 的
 *    `copy_dir_filtered`）会跳过这个目录名，包里有它也不会被解出来 ——
 *    依赖只能内联进 main.js，或放进顶层 `vendor/` / `bin/`。真出现这一条，
 *    说明有人把依赖又拷回包里了，用户装完就会缺文件。
 * 2. TypeScript 源码与类型声明一律不带（运行时加载的是 JS，过去占过 400+ KiB）。
 */
const nodeModulesEntry = entries.find((e) => e.name === "node_modules/" || e.name.startsWith("node_modules/"));
if (nodeModulesEntry) {
  report(
    `node_modules must not be packaged: ${nodeModulesEntry.name} ` +
      "(the installer skips that directory, so it would never reach the user)",
  );
} else {
  ok("no node_modules in the archive (every dependency is inlined in main.js)");
}
const tsEntry = entries.find((e) => !e.isDir && (e.name.endsWith(".d.ts") || e.name.endsWith(".ts")));
if (tsEntry) report(`should not be packaged: ${tsEntry.name} (TypeScript sources are not read at runtime)`);
else ok("no TypeScript sources or declarations in the archive");

/* ── manifest 能解析、版本一致 ────────────────────────────────────────── */
const { readFile } = await import("node:fs/promises");
const manifestText = await readFile("manifest.json", "utf8").catch(() => null);
const stagedText = await readFile("dist/stage/manifest.json", "utf8").catch(() => null);
if (stagedText) {
  const version = JSON.parse(stagedText).version;
  if (!names.has("manifest.json")) report("manifest.json is not in the archive");
  else ok(`archive carries manifest.json (version ${version})`);
}
void manifestText;

/* ── 产物架构自检：helper 必须是可执行文件而不是目录 ───────────────────── */
const helperEntry = entries.find((e) => e.name.includes("fancy-pty-helper"));
if (helperEntry) ok(`pty helper entry: ${helperEntry.name}`);
else report("no pty helper entry in the archive");

if (!existsSync(file)) report(`archive disappeared: ${file}`);

const failed = problems.length;
console.log(failed ? `\nPACKAGE CHECK FAILED (${failed})` : "\nPACKAGE CHECK OK");
process.exit(failed ? 1 : 0);
