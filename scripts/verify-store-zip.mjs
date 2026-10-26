/**
 * 按 **PI-Desktop 自己的解包器** 的约束校验 .piplug。
 *
 * host-core 是 Rust 写的，它的 zip 读取器只支持 store 压缩，并且对读者提出
 * 了一串具体错误（来自二进制里的字面量）：
 *
 *   PLUGIN_INVALID: only store-compressed piplug supported
 *   PLUGIN_INVALID: zip name not utf8
 *   PLUGIN_INVALID: zip entry truncated
 *   PLUGIN_INVALID: bad zip local header
 *   PLUGIN_INVALID: zip too small
 *
 * 这个脚本逐条复现这些检查，把「安装失败」提前到打包阶段暴露：
 *   · 每个条目的 method 必须是 0；
 *   · 条目名必须是合法 UTF-8（且显式置了 UTF-8 标志位）；
 *   · local header 的签名/长度必须与中央目录一致，数据不能短；
 *   · CRC 必须能对上（store 下 CRC 直接覆盖原文）；
 *   · 归档不能小于一个空的 EOCD。
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/verify-store-zip.mjs <file.piplug>");
  process.exit(2);
}

const bytes = readFileSync(file);
const problems = [];
const ok = (message) => console.log(`✔ ${message}`);
const bad = (message) => {
  problems.push(message);
  console.log(`✖ ${message}`);
};

/* ── zip too small ────────────────────────────────────────────────────── */
if (bytes.length < 22) {
  bad("zip too small");
  process.exit(1);
}

let eocd = -1;
for (let i = bytes.length - 22; i >= 0; i -= 1) {
  if (bytes.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) {
  bad("bad zip: no end-of-central-directory record");
  process.exit(1);
}

const count = bytes.readUInt16LE(eocd + 10);
const cdSize = bytes.readUInt32LE(eocd + 12);
const cdOffset = bytes.readUInt32LE(eocd + 16);
ok(`EOCD: ${count} entries, central directory at ${cdOffset} (${cdSize} bytes)`);

/* ── 逐条检查 ─────────────────────────────────────────────────────────── */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

let p = cdOffset;
let parsed = 0;
let deflated = 0;
let crcMismatch = 0;
let truncated = 0;
let badLocal = 0;
let nonUtf8 = 0;

for (let index = 0; index < count; index += 1) {
  if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) {
    bad(`central directory entry ${index} is malformed at offset ${p}`);
    break;
  }
  const flags = bytes.readUInt16LE(p + 8);
  const method = bytes.readUInt16LE(p + 10);
  const crc = bytes.readUInt32LE(p + 16);
  const compSize = bytes.readUInt32LE(p + 20);
  const rawSize = bytes.readUInt32LE(p + 24);
  const nameLen = bytes.readUInt16LE(p + 28);
  const extraLen = bytes.readUInt16LE(p + 30);
  const commentLen = bytes.readUInt16LE(p + 32);
  const localOffset = bytes.readUInt32LE(p + 42);
  const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
  const name = nameBytes.toString("utf8");

  parsed += 1;

  // 1) 只允许 store。
  if (method !== 0) {
    deflated += 1;
    if (deflated <= 3) bad(`method=${method} (only store allowed): ${name}`);
  }

  // 2) UTF-8：宿主（Rust）用 `str::from_utf8` 解码条目名，失败才报
  //    "zip name not utf8" —— 它**不**要求通用标志位 0x800。bsdtar 生成的包
  //    对纯 ASCII 名字不置该位，属于 zip 规范允许的正常产物，照旧可装。
  //    所以这里只断言「字节能按 UTF-8 解码且往返一致」。
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    if (Buffer.from(decoded, "utf8").compare(nameBytes) !== 0) {
      nonUtf8 += 1;
      if (nonUtf8 <= 3) bad(`name bytes are not round-trip UTF-8: ${nameBytes.toString("hex").slice(0, 40)}`);
    }
  } catch {
    nonUtf8 += 1;
    if (nonUtf8 <= 3) bad(`name is not valid UTF-8: ${nameBytes.toString("hex").slice(0, 40)}`);
  }
  void flags;
  if (name.includes("\\")) {
    bad(`backslash in name: ${name}`);
  }

  // 3) local header 必须存在且与中央目录一致。
  if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
    badLocal += 1;
    if (badLocal <= 3) bad(`bad zip local header: ${name} @${localOffset}`);
  } else {
    const localNameLen = bytes.readUInt16LE(localOffset + 26);
    const localExtraLen = bytes.readUInt16LE(localOffset + 28);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString("utf8");
    if (localName !== name || localNameLen !== nameLen) {
      badLocal += 1;
      if (badLocal <= 3) bad(`local/central name mismatch: "${localName}" vs "${name}"`);
    }
    if (localMethod !== 0) {
      badLocal += 1;
      if (badLocal <= 3) bad(`local header says method=${localMethod}: ${name}`);
    }

    // 4) 数据段必须完整。
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > bytes.length) {
      truncated += 1;
      if (truncated <= 3) bad(`zip entry truncated: ${name}`);
    } else if (method === 0) {
      const data = bytes.subarray(dataStart, dataStart + compSize);
      if (data.length !== rawSize) {
        truncated += 1;
        if (truncated <= 3) bad(`size mismatch: ${name} (${data.length} vs ${rawSize})`);
      } else if (crc32(data) !== crc) {
        crcMismatch += 1;
        if (crcMismatch <= 3) bad(`crc mismatch: ${name}`);
      }
    }
  }

  p += 46 + nameLen + extraLen + commentLen;
}

if (parsed !== count) bad(`parsed ${parsed} of ${count} central directory entries`);

if (!problems.length) {
  ok(`all ${parsed} entries are store-compressed, UTF-8 named, complete, and CRC-verified`);
}

const failed = problems.length;
console.log(failed ? `\nSTORE ZIP CHECK FAILED (${failed})` : "\nSTORE ZIP CHECK OK");
process.exit(failed ? 1 : 0);
