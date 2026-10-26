/**
 * SFTP 传输验证：真实 ssh2 服务端 + 手写最小 SFTP 子系统 + 真实的 ssh2-sftp-client。
 *
 * 这一步单测替代不了：它要证明「一条已经认证的 ssh2 连接上，我们的 SshTransport
 * 能借出 SFTP 通道，并且 ssh2-sftp-client 的 put / fastPut / uploadDir /
 * get / fastGet / downloadDir 在这条通道上真的把字节送到了对端」。
 *
 * 服务端是按 SFTP 协议手搓的最小实现：OPEN/READ/WRITE/CLOSE/FSTAT/STAT/SETSTAT/
 * MKDIR/OPENDIR/READDIR/REMOVE/RMDIR/REALPATH。不实现链接、权限与锁 ——
 * 这里验的是我们的调用方式，不是再验一遍 sftp 服务端。
 *
 * 覆盖：文本 put(buffer)、文件 fastPut、文件 put(readable)（stream=true）、
 * 目录 uploadDir（两种模式）、内联 get(remotePath)、文件 fastGet、文件
 * get(remotePath, writable)、目录 downloadDir（两种模式）、内联上限、断连失败。
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { SshTransport } = await import("../dist-ssh-test.mjs");
const { KnownHosts } = await import("../dist-known-hosts-test.mjs");
const { uploadVia, downloadVia } = await import("../dist-sftp-test.mjs");

let watchdog = setTimeout(() => {
  console.log("✖ sftp check timed out after 90s");
  process.exit(1);
}, 90_000);
watchdog.unref?.();

const results = [];
const ok = (message) => {
  results.push(true);
  console.log(`✔ ${message}`);
};
const fail = (message) => {
  results.push(false);
  console.log(`✖ ${message}`);
};

const work = await mkdtemp(join(tmpdir(), "pi-terminal-sftp-"));
function keygen(name) {
  const path = join(work, name);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-q"], { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(path) : reject(new Error(`ssh-keygen exited ${code}`))));
  });
}

const hostKey = await readFile(await keygen("host"));
const clientKey = await readFile(await keygen("client"));
const clientPublicBlob = (() => {
  const parsed = utils.parseKey(clientKey);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first.getPublicSSH().toString("base64");
})();

/* ── 最小 SFTP 子系统 ─────────────────────────────────────────────────── */

const files = new Map(); // path -> { data, mode }
const dirs = new Set(["/", "/tmp"]);
const handles = new Map(); // id -> { kind, path, listing, sent }
let nextHandle = 1;

const parentOf = (path) => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

function ensureDir(path) {
  if (dirs.has(path)) return;
  ensureDir(parentOf(path));
  dirs.add(path);
}

function attrsOf(path) {
  if (dirs.has(path)) return { mode: 0o040755, uid: 1000, gid: 1000, size: 0, atime: 0, mtime: 0 };
  const file = files.get(path);
  if (!file) return null;
  return { mode: 0o100000 | file.mode, uid: 1000, gid: 1000, size: file.data.length, atime: 0, mtime: 0 };
}

function childrenOf(path) {
  const prefix = path === "/" ? "/" : `${path}/`;
  const names = new Set();
  for (const candidate of [...files.keys(), ...dirs]) {
    if (!candidate.startsWith(prefix) || candidate === path) continue;
    const rest = candidate.slice(prefix.length);
    if (!rest) continue;
    names.add(rest.split("/")[0]);
  }
  return [...names].sort();
}

function describe(name, path) {
  const full = path === "/" ? `/${name}` : `${path}/${name}`;
  const isDir = dirs.has(full);
  const size = isDir ? 0 : files.get(full)?.data.length ?? 0;
  return {
    filename: name,
    longname: `${isDir ? "d" : "-"}rw-r--r-- 1 user group ${String(size).padStart(8)} Jan  1 00:00 ${name}`,
    attrs: attrsOf(full) ?? { mode: isDir ? 0o040755 : 0o100644, uid: 1000, gid: 1000, size, atime: 0, mtime: 0 },
  };
}

const modeOf = (attrs) => {
  if (!attrs || attrs.mode === undefined) return undefined;
  const mode = typeof attrs.mode === "string" ? Number.parseInt(attrs.mode, 8) : attrs.mode;
  return Number.isFinite(mode) ? mode & 0o7777 : undefined;
};

/** 记录每个文件「最后看到的 mode」，用来断言 644/600 真的写进了请求。 */
const appliedModes = new Map();

function attachSftp(sftp) {
  sftp.on("REALPATH", (reqid, path) => {
    sftp.name(reqid, [{ filename: path, longname: path, attrs: attrsOf(path) ?? {} }]);
  });

  // ssh2 交给服务端的 flags 是数值位掩码（READ/WRITE/APPEND/CREAT/TRUNC/EXCL），
  // 不是 'w'/'r' 字符串。只有带 TRUNC 的打开才截断 —— fastGet/get 用的也是 OPEN，
  // 把它们的打开当成写会把源文件清空（这一版就踩在这里：下载全是空文件）。
  const OPEN_TRUNC = 0x00000010;
  const OPEN_WRITE = 0x00000002;
  const OPEN_CREAT = 0x00000008;
  sftp.on("OPEN", (reqid, filename, flags, attrs) => {
    const id = nextHandle++;
    const mode = modeOf(attrs) ?? 0o644;
    const existing = files.get(filename);
    const creating = typeof flags === "number" ? (flags & (OPEN_WRITE | OPEN_CREAT)) !== 0 : true;
    const truncating = typeof flags === "number" ? (flags & OPEN_TRUNC) !== 0 : false;
    if (!existing && creating) files.set(filename, { data: Buffer.alloc(0), mode });
    if (truncating) files.get(filename).data = Buffer.alloc(0);
    appliedModes.set(filename, mode);
    handles.set(id, { kind: "file", path: filename });
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id, 0);
    sftp.handle(reqid, handle);
  });

  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const entry = handles.get(handle.readUInt32BE(0));
    if (!entry) return sftp.status(reqid, 4);
    const file = files.get(entry.path);
    if (!file) return sftp.status(reqid, 2);
    const end = offset + data.length;
    if (file.data.length < end) {
      const grown = Buffer.alloc(end);
      file.data.copy(grown);
      file.data = grown;
    }
    Buffer.from(data).copy(file.data, offset);
    sftp.status(reqid, 0);
  });

  sftp.on("READ", (reqid, handle, offset, length) => {
    const entry = handles.get(handle.readUInt32BE(0));
    const file = entry ? files.get(entry.path) : null;
    if (!file) return sftp.status(reqid, 2);
    if (offset >= file.data.length) return sftp.status(reqid, 1); // EOF
    sftp.data(reqid, file.data.subarray(offset, Math.min(file.data.length, offset + length)));
  });

  sftp.on("FSTAT", (reqid, handle) => {
    const entry = handles.get(handle.readUInt32BE(0));
    const attrs = entry ? attrsOf(entry.path) : null;
    if (!attrs) return sftp.status(reqid, 2);
    sftp.attrs(reqid, attrs);
  });

  const statHandler = (reqid, path) => {
    const attrs = attrsOf(path);
    if (!attrs) return sftp.status(reqid, 2);
    sftp.attrs(reqid, attrs);
  };
  sftp.on("STAT", statHandler);
  sftp.on("LSTAT", statHandler);

  // fastPut 的 mode 不是随 OPEN 来的：ssh2 打开文件后再 fchmod 一次。
  sftp.on("FSETSTAT", (reqid, handle, attrs) => {
    const entry = handles.get(handle.readUInt32BE(0));
    const mode = modeOf(attrs);
    if (entry && mode !== undefined) {
      appliedModes.set(entry.path, mode);
      const file = files.get(entry.path);
      if (file) file.mode = mode;
    }
    sftp.status(reqid, 0);
  });
  sftp.on("SETSTAT", (reqid, path, attrs) => {
    const mode = modeOf(attrs);
    if (mode !== undefined) appliedModes.set(path, mode);
    sftp.status(reqid, 0);
  });

  sftp.on("CLOSE", (reqid, handle) => {
    handles.delete(handle.readUInt32BE(0));
    sftp.status(reqid, 0);
  });

  sftp.on("MKDIR", (reqid, path) => {
    ensureDir(path);
    sftp.status(reqid, 0);
  });

  sftp.on("OPENDIR", (reqid, path) => {
    if (!dirs.has(path)) return sftp.status(reqid, 2);
    const id = nextHandle++;
    handles.set(id, { kind: "dir", path, listing: childrenOf(path), sent: false });
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id, 0);
    sftp.handle(reqid, handle);
  });

  sftp.on("READDIR", (reqid, handle) => {
    const entry = handles.get(handle.readUInt32BE(0));
    if (!entry || entry.kind !== "dir") return sftp.status(reqid, 2);
    if (entry.sent) return sftp.status(reqid, 1); // EOF
    entry.sent = true;
    sftp.name(reqid, entry.listing.map((name) => describe(name, entry.path)));
  });

  sftp.on("REMOVE", (reqid, path) => {
    files.delete(path);
    sftp.status(reqid, 0);
  });
  sftp.on("RMDIR", (reqid, path) => {
    dirs.delete(path);
    sftp.status(reqid, 0);
  });
}

function startServer() {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject();
      return ctx.key?.data?.toString("base64") === clientPublicBlob ? ctx.accept() : ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => typeof acceptPty === "function" && acceptPty());
        session.on("shell", (acceptShell) => acceptShell());
        session.on("sftp", (acceptSftp) => attachSftp(acceptSftp()));
      });
    });
    client.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** 把 SFTP 上收到的文件读成字节。 */
const remoteBytes = (path) => files.get(path)?.data ?? null;

const listen = await startServer();
ok(`sftp-capable ssh2 server listening on 127.0.0.1:${listen.port}`);

const profile = {
  id: "00000000-0000-0000-0000-0000000000ff",
  name: "sftp test",
  host: "127.0.0.1",
  port: listen.port,
  user: "smoke",
  auth: "key",
  term: "xterm-256color",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

let transport;
try {
  transport = await SshTransport.open(
    profile,
    { privateKey: clientKey },
    { cols: 100, rows: 30 },
    { onData: () => undefined, onExit: () => undefined, onError: () => undefined },
    { onHostKey: async () => true, onProgress: () => undefined },
    await KnownHosts.load(work),
  );
  ok("ssh session established (sftp operations reuse it)");
} catch (error) {
  fail(`could not open the ssh session: ${error.message}`);
}

/** 所有操作都走同一个入口：借已认证连接的 SFTP 通道。 */
const withSftp = (fn) => transport.withSftp(fn);

/* ── 1. 内联文本 → put(buffer) ──────────────────────────────────────── */
const text = "# pi-terminal sftp\nline two\n";
try {
  const outcome = await withSftp((sftp) =>
    uploadVia(sftp, { remotePath: "/tmp/pi-text.txt", content: Buffer.from(text, "utf8"), mode: 0o600, stream: false }),
  );
  if (outcome.kind !== "text") fail(`expected kind text, got ${outcome.kind}`);
  else if (remoteBytes("/tmp/pi-text.txt")?.toString("utf8") !== text) fail("text content did not match");
  else if (appliedModes.get("/tmp/pi-text.txt") !== 0o600) {
    fail(`expected mode 600, got ${appliedModes.get("/tmp/pi-text.txt")?.toString(8)}`);
  } else ok(`text upload via ${outcome.transport} arrived byte-for-byte with mode 600`);
} catch (error) {
  fail(`text upload failed: ${error.message}`);
}

/* ── 2. 本地文件 → fastPut ──────────────────────────────────────────── */
const binary = Buffer.from(Array.from({ length: 5000 }, (_, index) => (index * 37) % 256));
const localBinary = join(work, "payload.bin");
await writeFile(localBinary, binary);
try {
  const outcome = await withSftp((sftp) =>
    uploadVia(sftp, { remotePath: "/tmp/pi-fast.bin", localPath: localBinary, mode: 0o640, stream: false }),
  );
  const got = remoteBytes("/tmp/pi-fast.bin");
  if (outcome.kind !== "file" || !outcome.transport.includes("fastPut")) fail(`unexpected outcome: ${JSON.stringify(outcome)}`);
  else if (!got || !got.equals(binary)) fail("fastPut content did not match");
  else if (appliedModes.get("/tmp/pi-fast.bin") !== 0o640) {
    fail(`expected mode 640, got ${appliedModes.get("/tmp/pi-fast.bin")?.toString(8)}`);
  } else ok(`file upload via ${outcome.transport} (${binary.length} bytes, mode 640)`);
} catch (error) {
  fail(`fastPut upload failed: ${error.message}`);
}

/* ── 3. 本地文件 + stream → put(readable) ───────────────────────────── */
try {
  const outcome = await withSftp((sftp) =>
    uploadVia(sftp, { remotePath: "/tmp/pi-stream.bin", localPath: localBinary, stream: true }),
  );
  const got = remoteBytes("/tmp/pi-stream.bin");
  if (!outcome.transport.includes("put(readable)")) fail(`unexpected transport: ${outcome.transport}`);
  else if (!got || !got.equals(binary)) fail("stream upload content did not match");
  else ok(`file upload via ${outcome.transport} (stream=true)`);
} catch (error) {
  fail(`stream upload failed: ${error.message}`);
}

/* ── 4/5. 目录 → uploadDir（fast / stream）──────────────────────────── */
const localDir = join(work, "tree");
await mkdir(join(localDir, "sub"), { recursive: true });
await writeFile(join(localDir, "a.txt"), "alpha\n");
await writeFile(join(localDir, "sub", "b.txt"), "beta\n");

for (const [stream, remote, expect] of [
  [false, "/tmp/up-fast", "useFastput:true"],
  [true, "/tmp/up-stream", "useFastput:false"],
]) {
  try {
    const outcome = await withSftp((sftp) =>
      uploadVia(sftp, { remotePath: remote, localPath: localDir, stream }),
    );
    const aOk = remoteBytes(`${remote}/a.txt`)?.toString("utf8") === "alpha\n";
    const bOk = remoteBytes(`${remote}/sub/b.txt`)?.toString("utf8") === "beta\n";
    if (outcome.kind !== "directory" || !outcome.transport.includes(expect)) {
      fail(`unexpected outcome: ${JSON.stringify(outcome)}`);
    } else if (!aOk || !bOk) fail(`directory upload (stream=${stream}) content mismatch`);
    else if (outcome.entries !== 2) fail(`expected 2 entries, got ${outcome.entries}`);
    else ok(`directory upload via ${outcome.transport} (2 files, stream=${stream})`);
  } catch (error) {
    fail(`directory upload (stream=${stream}) failed: ${error.message}`);
  }
}

/* ── 6. 内联下载 → get(remotePath) ─────────────────────────────────── */
try {
  const outcome = await withSftp((sftp) =>
    downloadVia(sftp, { remotePath: "/tmp/pi-text.txt", stream: false, maxBytes: 65536 }),
  );
  if (!outcome.content) fail("inline download returned no content");
  else if (outcome.content.toString("utf8") !== text) fail("inline content did not match");
  else ok(`inline download via ${outcome.transport} (${outcome.bytes} bytes)`);
} catch (error) {
  fail(`inline download failed: ${error.message}`);
}

/* ── 7. 文件下载 → fastGet ─────────────────────────────────────────── */
try {
  const target = join(work, "out", "fast.bin");
  const outcome = await withSftp((sftp) =>
    downloadVia(sftp, { remotePath: "/tmp/pi-fast.bin", localPath: target, stream: false }),
  );
  const got = await readFile(target).catch(() => null);
  if (!outcome.transport.includes("fastGet")) fail(`unexpected transport: ${outcome.transport}`);
  else if (!got || !got.equals(binary)) fail("fastGet content did not match");
  else ok(`file download via ${outcome.transport} (${got.length} bytes, parent folder created)`);
} catch (error) {
  fail(`fastGet download failed: ${error.message}`);
}

/* ── 8. 文件下载 + stream → get(remotePath, writable) ──────────────── */
try {
  const target = join(work, "out", "stream.bin");
  const outcome = await withSftp((sftp) =>
    downloadVia(sftp, { remotePath: "/tmp/pi-stream.bin", localPath: target, stream: true }),
  );
  const got = await readFile(target).catch(() => null);
  if (!outcome.transport.includes("get(remotePath, writable)")) fail(`unexpected transport: ${outcome.transport}`);
  else if (!got || !got.equals(binary)) fail("streamed download content did not match");
  else ok(`file download via ${outcome.transport} (stream=true)`);
} catch (error) {
  fail(`streamed download failed: ${error.message}`);
}

/* ── 9/10. 目录下载 → downloadDir（fast / stream）───────────────────── */
for (const [stream, source, expect] of [
  [false, "/tmp/up-fast", "useFastget:true"],
  [true, "/tmp/up-stream", "useFastget:false"],
]) {
  try {
    const target = join(work, `down-${stream ? "stream" : "fast"}`);
    const outcome = await withSftp((sftp) =>
      downloadVia(sftp, { remotePath: source, localPath: target, stream }),
    );
    const a = await readFile(join(target, "a.txt"), "utf8").catch(() => "");
    const b = await readFile(join(target, "sub", "b.txt"), "utf8").catch(() => "");
    if (outcome.kind !== "directory" || !outcome.transport.includes(expect)) {
      fail(`unexpected outcome: ${JSON.stringify(outcome)}`);
    } else if (a !== "alpha\n" || b !== "beta\n") fail(`directory download (stream=${stream}) content mismatch`);
    else ok(`directory download via ${outcome.transport} (stream=${stream})`);
  } catch (error) {
    fail(`directory download (stream=${stream}) failed: ${error.message}`);
  }
}

/* ── 11. 内联上限必须拦住大文件 ─────────────────────────────────────── */
try {
  await withSftp((sftp) => downloadVia(sftp, { remotePath: "/tmp/pi-fast.bin", stream: false, maxBytes: 100 }));
  fail("an oversized inline download should have been refused");
} catch (error) {
  if (/inline limit/i.test(error.message)) ok("oversized inline download is refused with a clear message");
  else fail(`unexpected error for the inline limit: ${error.message}`);
}

/* ── 12. 断连后的传输必须失败而不是挂住 ─────────────────────────────── */
listen.server.close();
await transport?.kill().catch(() => undefined);
try {
  await withSftp((sftp) => uploadVia(sftp, { remotePath: "/tmp/after-close.txt", content: Buffer.from("x"), stream: false }));
  fail("uploading on a closed session should throw");
} catch (error) {
  ok(`upload after close throws: ${String(error.message).slice(0, 60)}`);
}

const info = await stat(join(work, "out", "fast.bin")).catch(() => null);
if (info && info.size === binary.length) console.log(`  (local fastGet file is ${info.size} bytes on disk)`);

clearTimeout(watchdog);
const failed = results.filter((value) => !value).length;
console.log(failed ? `\nSFTP CHECK FAILED (${failed})` : "\nSFTP CHECK OK");
process.exit(failed ? 1 : 0);
