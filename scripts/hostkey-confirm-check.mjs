/**
 * 首次连接的主机指纹确认（回归）。
 *
 * ── 这条曾经完全不可用 ─────────────────────────────────────────────────
 * 插件侧在 `onHostKey` 里等用户确认，宿主又没有「插件 → 面板」的推送，而视图那
 * 一侧从来没有人给 `state.pendingHostKey` 赋值：确认框永远不出现 → 20 秒后插件
 * 按拒绝处理 → **首次连接任意一台新主机必然失败**。
 *
 * 现在待确认项被写进会话摘要（`hostKeyPending`）。这个脚本驱动真实的
 * SessionRegistry + SshTransport，对着一台真实的 ssh2 服务器，断言三件事：
 *   1. 连接挂起期间，摘要里能看到 hostKeyPending（视图据此弹框）；
 *   2. 回填「信任」后连接真的完成，且摘要里的待确认项被清空；
 *   3. 回填「拒绝」时连接失败，而且**不写入** known_hosts。
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { SessionRegistry } = await import("../dist-sessions-test.mjs");
const { createSessionFactory } = await import("../dist-factory-test.mjs");

let watchdog = setTimeout(() => {
  console.log("✖ hostkey confirm check timed out after 60s");
  process.exit(1);
}, 60_000);
watchdog.unref?.();

const results = [];
const ok = (m) => {
  results.push(true);
  console.log(`✔ ${m}`);
};
const fail = (m) => {
  results.push(false);
  console.log(`✖ ${m}`);
};

const dir = await mkdtemp(join(tmpdir(), "pi-terminal-hostkey-"));
function keygen(name) {
  const path = join(dir, name);
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

const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject();
    return ctx.key?.data?.toString("base64") === clientPublicBlob ? ctx.accept() : ctx.reject();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => typeof acceptPty === "function" && acceptPty());
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        stream.write("PI_HOSTKEY_SMOKE_READY\r\n");
      });
      // 工厂会用 exec 跑一次 `pwd` 补齐 cwd：真实服务器上这一步必须有回应。
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.write(String(info?.command ?? "").trim() === "pwd" ? "/home/smoke\r\n" : "");
        stream.exit(0);
        stream.end();
      });
    });
  });
  client.on("error", () => undefined);
});
const port = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
ok(`ssh2 test server listening on 127.0.0.1:${port} (host key is not in known_hosts)`);

/**
 * 一台「待确认」的假机密档案存储：只提供 factory 需要的那几个方法。
 */
function makeProfiles(profile) {
  return {
    get: (id) => (id === profile.id ? profile : null),
    list: async () => [profile],
    credentials: async () => ({ privateKey: clientKey }),
  };
}

/** 统一的工厂构造：askHostKey 由每个用例自己给（模拟用户点按钮）。 */
function makeRegistry(profile, askHostKey) {
  return new SessionRegistry(
    createSessionFactory({
      settings: () => ({ sshKeepaliveSeconds: 20, defaultShell: "", defaultCwdMode: "workspace" }),
      dataDir: dir,
      profiles: makeProfiles(profile),
      secrets: {},
      workspaceRoot: async () => null,
      askHostKey,
      audit: () => undefined,
    }),
    { maxSessions: 4, bufferBytes: 1024 * 1024, coalesceMs: 0 },
  );
}

const profile = {
  id: "00000000-0000-0000-0000-0000000000aa",
  name: "hostkey test",
  host: "127.0.0.1",
  port,
  user: "smoke",
  auth: "key",
  term: "xterm-256color",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/** 等到 registry 里出现 hostKeyPending（视图轮询做的就是这件事）。 */
async function waitForPending(registry, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = registry.list().find((session) => session.hostKeyPending)?.hostKeyPending;
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/* ── 1. 摘要里出现待确认项，确认后连接成功 ───────────────────────────── */
let decide = null;
const registry = makeRegistry(profile, () => new Promise((resolve) => (decide = resolve)));

const opening = registry.open({ kind: "ssh", cols: 90, rows: 24, profile }).catch((error) => error);
const pending = await waitForPending(registry);

if (!pending) {
  fail("no hostKeyPending ever reached the session summary (the confirmation dialog could never appear)");
} else if (pending.host !== "127.0.0.1" || pending.port !== port) {
  fail(`unexpected pending host: ${JSON.stringify(pending)}`);
} else if (!/^SHA256:/.test(pending.fingerprint)) {
  fail(`pending fingerprint is not OpenSSH-shaped: ${pending.fingerprint}`);
} else {
  ok("the session summary carries hostKeyPending while the connection waits for the user");
}

if (typeof decide === "function") decide(true);
else fail("the transport never asked for a host key decision");

const opened = await opening;
if (opened && opened.id) {
  ok("the connection completes once the user trusts the fingerprint");
  const after = registry.get(opened.id)?.hostKeyPending;
  if (after === undefined) ok("the pending entry is cleared after the decision");
  else fail(`hostKeyPending was not cleared: ${JSON.stringify(after)}`);
  await registry.close(opened.id);
} else {
  fail(`connection failed after trusting the key: ${opened?.message ?? opened}`);
}
await registry.closeAll();

/* ── 2. 用户拒绝：连接失败，且不写 known_hosts ───────────────────────── */
// 上一用例成功之后这台主机已经被信任，必须先把它忘掉，否则这里根本不会询问 ——
// 那会让「拒绝」这条路径压根没被测到（第一次跑就是这么假绿的）。
const { rm: rmFile } = await import("node:fs/promises");
await rmFile(join(dir, "known_hosts"), { force: true });
const knownBefore = await readFile(join(dir, "known_hosts"), "utf8").catch(() => "");
const registry2 = makeRegistry(profile, async () => false);
const refused = await registry2.open({ kind: "ssh", cols: 80, rows: 24, profile }).catch((error) => error);
if (refused && !refused.id) {
  ok(`refusing the fingerprint fails the connection: ${String(refused.message).slice(0, 48)}…`);
} else {
  fail("refusing the fingerprint still produced a session");
}
const knownAfter = await readFile(join(dir, "known_hosts"), "utf8").catch(() => "");
if (knownAfter === knownBefore) ok("a refused fingerprint is not written to known_hosts");
else fail("a refused fingerprint was written to known_hosts");
await registry2.closeAll();

/* ── 3. SSH 会话的 cwd 来自远端，而不是空串 ───────────────────────────── */
// `probeCwd()` 曾只返回一个从未被赋值的字段，于是每个 SSH 标签的提示都是
// 「unknown cwd」。现在工厂会在已认证连接上真的问一次 `pwd`。
await rmFile(join(dir, "known_hosts"), { force: true });
const registry3 = makeRegistry(profile, async () => true);
const withCwd = await registry3.open({ kind: "ssh", cols: 80, rows: 24, profile }).catch((error) => error);
if (withCwd && withCwd.id) {
  const cwd = registry3.get(withCwd.id)?.cwd ?? "";
  if (cwd === "/home/smoke") ok(`the SSH session reports the remote cwd: ${cwd}`);
  else fail(`the SSH session cwd is not what the remote reported: ${JSON.stringify(cwd)}`);
  await registry3.close(withCwd.id);
} else {
  fail(`could not open a session to check cwd: ${withCwd?.message ?? withCwd}`);
}
await registry3.closeAll();

server.close();
clearTimeout(watchdog);
const failed = results.filter((value) => !value).length;
console.log(failed ? `\nHOSTKEY CONFIRM CHECK FAILED (${failed})` : "\nHOSTKEY CONFIRM CHECK OK");
process.exit(failed ? 1 : 0);
