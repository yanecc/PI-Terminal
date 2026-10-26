/**
 * 检查 .piplug（zip）的结构问题。
 *
 * Windows 解包报 `os error 183`（ERROR_ALREADY_EXISTS）通常来自：
 *   · 压缩包里有重复条目；
 *   · 条目用反斜杠当分隔符，解包器按不同规则建目录时撞名；
 *   · 大小写不同的同名条目（Windows 不区分大小写）；
 *   · 目录条目与文件条目同名。
 * 这个脚本把四类问题都查一遍。
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "dist/pi-terminal-0.1.3.piplug";
const bytes = readFileSync(file);

// 定位 EOCD（End Of Central Directory）。
let eocd = -1;
for (let i = bytes.length - 22; i >= 0; i -= 1) {
  if (bytes.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  console.error("not a zip: EOCD not found");
  process.exit(1);
}

const total = bytes.readUInt16LE(eocd + 10);
const cdOffset = bytes.readUInt32LE(eocd + 16);
console.log(`${file}: EOCD says ${total} entries`);

const entries = [];
let p = cdOffset;
while (p < bytes.length && bytes.readUInt32LE(p) === 0x02014b50) {
  const flags = bytes.readUInt16LE(p + 8);
  const nameLen = bytes.readUInt16LE(p + 28);
  const extraLen = bytes.readUInt16LE(p + 30);
  const commentLen = bytes.readUInt16LE(p + 32);
  const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
  // bit 11 = UTF-8。Compress-Archive 在 Windows 上常写成 GBK/ANSI，这里先按 utf8 读，
  // 读坏了会在下面的 "non-ascii" 里报出来。
  const name = rawName.toString(flags & 0x800 ? "utf8" : "utf8");
  entries.push({
    name,
    isDir: name.endsWith("/") || name.endsWith("\\"),
    hasBackslash: name.includes("\\"),
    nonAscii: /[^\x20-\x7e]/.test(name),
  });
  p += 46 + nameLen + extraLen + commentLen;
}

console.log(`parsed ${entries.length} entries`);

const byExact = new Map();
const byLower = new Map();
const dupExact = [];
const dupCase = [];
for (const entry of entries) {
  const key = entry.name;
  if (byExact.has(key)) dupExact.push(key);
  else byExact.set(key, entry);

  const lower = key.toLowerCase().replace(/\\/g, "/");
  if (byLower.has(lower)) dupCase.push([byLower.get(lower).name, key]);
  else byLower.set(lower, entry);
}

const withBackslash = entries.filter((entry) => entry.hasBackslash);
const nonAscii = entries.filter((entry) => entry.nonAscii);

// 目录条目与文件条目同名：`foo/` 与 `foo` 同时出现时，解包器可能先建目录再建同名文件。
const dirs = new Set(entries.filter((entry) => entry.isDir).map((entry) => entry.name.replace(/[\\/]+$/, "").toLowerCase()));
const fileDirs = entries.filter((entry) => !entry.isDir && dirs.has(entry.name.toLowerCase()));

console.log(`duplicate exact names : ${dupExact.length}`);
if (dupExact.length) console.log("  ", dupExact.slice(0, 10));
console.log(`case-insensitive dupes: ${dupCase.length}`);
if (dupCase.length) console.log("  ", dupCase.slice(0, 10));
console.log(`entries with backslash: ${withBackslash.length}`);
if (withBackslash.length) console.log("  ", withBackslash.slice(0, 5).map((e) => e.name));
console.log(`non-ascii names       : ${nonAscii.length}`);
if (nonAscii.length) console.log("  ", nonAscii.slice(0, 5).map((e) => e.name));
console.log(`dir/file name clashes : ${fileDirs.length}`);
if (fileDirs.length) console.log("  ", fileDirs.slice(0, 5).map((e) => e.name));
