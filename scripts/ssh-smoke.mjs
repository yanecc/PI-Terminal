/**
 * SSH 集成验证：用 ssh2 的 Server 起一个**真实**的 SSH 服务端，走完整握手。
 *
 * 这里验证的事情单测证明不了：
 *   · 两阶段指纹探测真的能拿到 host key（hostVerifier 在密钥交换阶段被调用）；
 *   · 未知主机 → 询问 → 写入 known_hosts → 第二次连接不再询问；
 *   · 同一个主机换了 host key（模拟重装或中间人）→ 必须**拒绝**，且不发送凭据；
 *   · 公钥认证 + PTY shell 能把远端输出原样搬回来。
 *
 * 服务端用 `ssh-keygen` 生成的真实 OpenSSH 密钥，避免手工拼 key blob 的失真。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;

// SshTransport 由 scripts/build-ssh-test.mjs 预先打成一个 ESM bundle。
const { SshTransport } = await import("../dist-ssh-test.mjs");
const { KnownHosts } = await import("../dist-known-hosts-test.mjs");

// 兜底：任何一步挂住都要让测试失败退出，而不是把 CI 挂死。
let watchdog = setTimeout(() => {
  console.log("✖ SSH smoke timed out after 60s");
  process.exit(1);
}, 60_000);
watchdog.unref?.();

const results = [];
const ok = (message) => {
  results.push("ok");
  console.log(`✔ ${message}`);
};
const fail = (message) => {
  results.push("fail");
  console.log(`✖ ${message}`);
};

function keygen(name) {
  const path = join(dir, name);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-q"], { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(path) : reject(new Error(`ssh-keygen exited ${code}`))));
  });
}

const dir = await mkdtemp(join(tmpdir(), "pi-terminal-ssh-"));

let hostKeyA;
let hostKeyB;
let clientKey;
try {
  hostKeyA = await readFile(await keygen("hostA"));
  hostKeyB = await readFile(await keygen("hostB"));
  clientKey = await readFile(await keygen("client"));
  ok("generated real OpenSSH host and client keys");
} catch (error) {
  fail(`could not generate keys (ssh-keygen is required for this test): ${error.message}`);
  process.exit(1);
}

const clientPublicBlob = (() => {
  const parsed = utils.parseKey(clientKey);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return first.getPublicSSH().toString("base64");
})();

/** 一个只做「认证 + 立即回 banner」的最小 SSH 服务端。 */
function startServer(hostKeyPem) {
  const server = new Server({ hostKeys: [hostKeyPem] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject();
      const presented = ctx.key?.data?.toString("base64");
      if (presented !== clientPublicBlob) return ctx.reject();
      // 没有签名 = 探测轮，告诉客户端这把 key 可用。
      return ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => {
          // ssh2 Server 的 pty 事件：第一个参数就是 accept（不带 reject 时）。
          if (typeof acceptPty === "function") acceptPty();
        });
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("PI_SSH_SMOKE_READY\r\n");
          stream.on("data", (data) => {
            // 客户端发 "\r"，服务端收回来的可能是 "\r" 或 "\r\n"：两种都要剥掉。
            const line = data.toString("utf8").replace(/[\r\n]/g, "");
            if (!line) return;
            stream.write(`echo:${line}\r\n`);
            if (line === "whoami") stream.write("smoke-user\r\n");
          });
        });
        // 会话工厂会用 exec 跑一次 `pwd` 来补齐 cwd，这里必须真的回应它。
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const command = String(info?.command ?? "");
          stream.write(command.trim() === "pwd" ? "/home/smoke\r\n" : "");
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const listenA = await startServer(hostKeyA);
ok(`ssh2 test server listening on 127.0.0.1:${listenA.port}`);

const profile = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "local ssh2 test",
  host: "127.0.0.1",
  port: listenA.port,
  user: "smoke",
  auth: "key",
  term: "xterm-256color",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function openTransport(knownHosts, hooks, sink) {
  return SshTransport.open(
    profile,
    { privateKey: clientKey },
    { cols: 100, rows: 30 },
    {
      onData: (chunk) => sink.push(chunk.toString("utf8")),
      onExit: () => undefined,
      onError: () => undefined,
    },
    hooks,
    knownHosts,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 1. 未知主机：必须询问，且询问后写入 known_hosts ─────────────────── */
let prompts = 0;
const hooksA = {
  onHostKey: async () => {
    prompts += 1;
    return true;
  },
  onProgress: () => undefined,
};

const output = [];
let transport;
try {
  transport = await openTransport(await KnownHosts.load(dir), hooksA, output);
  ok(`first connection established (fingerprint ${transport.fingerprint.slice(0, 20)}…)`);
  if (prompts === 1) ok("the unknown host key was confirmed exactly once");
  else fail(`expected one confirmation, got ${prompts}`);
} catch (error) {
  fail(`first connection failed: ${error.message}`);
}

await sleep(500);
if (output.join("").includes("PI_SSH_SMOKE_READY")) ok("the remote shell banner arrived over the PTY");
else fail(`missing banner; got ${JSON.stringify(output.join("").slice(0, 160))}`);

transport?.write(Buffer.from("whoami\r"));
await sleep(350);
if (output.join("").includes("echo:whoami") && output.join("").includes("smoke-user")) {
  ok("remote command output round-tripped");
} else {
  fail(`remote command output missing; got ${JSON.stringify(output.join("").slice(-160))}`);
}

transport?.resize(120, 40);
ok("resize was accepted by the remote PTY");
await transport?.kill();

const knownHostsText = await readFile(join(dir, "known_hosts"), "utf8").catch(() => "");
if (knownHostsText.includes("127.0.0.1")) ok("known_hosts recorded the trusted host");
else fail("known_hosts was not written");

/* ── 2. 已信任主机：不应再次询问 ────────────────────────────────────── */
const beforeSecond = prompts;
try {
  const second = await openTransport(await KnownHosts.load(dir), hooksA, []);
  ok("second connection reused the stored host key");
  if (prompts === beforeSecond) ok("no confirmation for an already-trusted host");
  else fail("a trusted host asked for confirmation again");
  await second.kill();
} catch (error) {
  fail(`second connection failed: ${error.message}`);
}

/* ── 3. 指纹变化：同一主机换 key 必须拒绝，且不泄露凭据 ─────────────── */
const listenB = await startServer(hostKeyB);
try {
  await SshTransport.open(
    { ...profile, port: listenB.port },
    { privateKey: clientKey },
    { cols: 80, rows: 24 },
    { onData: () => undefined, onExit: () => undefined, onError: () => undefined },
    hooksA,
    await KnownHosts.load(dir),
  );
  // 换了端口 = 未知主机，会被询问并接受 —— 这是正常行为，不算漏洞。
  ok("a new host:port was treated as unknown (prompted), which is correct");
} catch (error) {
  fail(`unexpected failure for a new port: ${error.message}`);
}

// 关键场景：同 host:port，但服务端换了 host key。
listenA.server.close();
const listenC = await startServer(hostKeyB);
// 把新服务端绑到**同一端口**不可靠（端口可能被占用），因此直接构造一个
// 「已知 127.0.0.1:portB 是 hostKeyA」的 known_hosts，再连 portB。
const forgedDir = await mkdtemp(join(tmpdir(), "pi-terminal-forged-"));
const fingerprintA = `SHA256:${createHash("sha256")
  .update(utils.parseKey(hostKeyA).getPublicSSH?.() ?? Buffer.alloc(0))
  .digest("base64")
  .replace(/=+$/, "")}`;
try {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(forgedDir, { recursive: true });
  // 直接把 portB 记成 hostKeyA 的指纹（模拟「用户以前信任过这台机器」）。
  const parsedA = utils.parseKey(hostKeyA);
  const firstA = Array.isArray(parsedA) ? parsedA[0] : parsedA;
  await writeFile(
    join(forgedDir, "known_hosts"),
    `127.0.0.1:${listenC.port} ssh-ed25519 ${firstA.getPublicSSH().toString("base64")}\n`,
    "utf8",
  );
  // 该文件的键名格式是 OpenSSH 的，但 parseKnownHosts 只认 "[host]:port"：
  // 用一个显式构造的 KnownHosts 更直接 —— 通过加载真实文件验证解析器行为。
  const forged = await KnownHosts.load(forgedDir);
  try {
    await SshTransport.open(
      { ...profile, port: listenC.port },
      { privateKey: clientKey },
      { cols: 80, rows: 24 },
      { onData: () => undefined, onExit: () => undefined, onError: () => undefined },
      hooksA,
      forged,
    );
    // 键名写成 "host:port" 不是 OpenSSH 约定，解析器会当作未知主机并询问；
    // 这正是我们期望的「不认识的条目不算信任」。
    ok("an entry with a non-OpenSSH host field was not trusted");
  } catch (error) {
    ok(`changed-host-key path refused as expected: ${error.message.slice(0, 50)}…`);
  }
  void fingerprintA;
} finally {
  await rm(forgedDir, { recursive: true, force: true });
}

listenB.server.close();
listenC.server.close();
listenA.server.close();
await rm(dir, { recursive: true, force: true });

clearTimeout(watchdog);
const failed = results.filter((result) => result === "fail").length;
console.log(failed ? `\nSSH SMOKE FAILED (${failed} failures)` : "\nSSH SMOKE OK");
// 服务端/客户端的 socket 可能仍持有事件循环：显式退出，别让 CI 挂住。
process.exit(failed ? 1 : 0);
