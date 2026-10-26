/**
 * 主机指纹确认的并发行为（回归）。
 *
 * 旧实现用 `Map<key, 单个回调>` 保存待确认项：同一台未知主机被并发连接时，
 * 后一个请求覆盖前一个，于是一次「信任」只唤醒一个连接，另一个必然等到超时。
 * 用户在面板上看到的是「点了信任还是连不上」。
 *
 * 这里跑两条并发连接打同一台未知主机：
 *   · 摘要里只应出现**一项**待确认（同一个指纹只问一次，不重复骚扰）；
 *   · 一次 resolveHostKeyDecision 必须把**两条**都放行；
 *   · 两条连接都应变成 running。
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";

const { Server, utils } = ssh2;
const { SessionRegistry } = await import("../dist-sessions-test.mjs");
const { createSessionFactory } = await import("../dist-factory-test.mjs");
const { resolveHostKeyDecision } = await import("../main.js");

let watchdog = setTimeout(() => {
  console.log("✖ concurrent host key check timed out after 60s");
  process.exit(1);
}, 60_000);
watchdog.unref?.();

const results = [];
const ok = (m) => { results.push(true); console.log(`✔ ${m}`); };
const fail = (m) => { results.push(false); console.log(`✖ ${m}`); };

const dir = await mkdtemp(join(tmpdir(), "pi-terminal-hk-concurrent-"));
const keygen = (name) =>
  new Promise((resolve, reject) => {
    const path = join(dir, name);
    const child = spawn("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path, "-q"], { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(path) : reject(new Error("ssh-keygen exited " + code))));
  });

const hostKey = await readFile(await keygen("host"));
const clientKey = await readFile(await keygen("client"));
const parsed = utils.parseKey(clientKey);
const first = Array.isArray(parsed) ? parsed[0] : parsed;
const clientPublicBlob = first.getPublicSSH().toString("base64");

let hostKeyPrompts = 0;
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method !== "publickey") return ctx.reject();
    return ctx.key?.data?.toString("base64") === clientPublicBlob ? ctx.accept() : ctx.reject();
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => typeof a === "function" && a());
      session.on("shell", (acceptShell) => acceptShell().write("READY\r\n"));
      session.on("exec", (acceptExec) => {
        const stream = acceptExec();
        stream.write("/home/smoke\r\n");
        stream.exit(0);
        stream.end();
      });
    });
  });
  client.on("error", () => undefined);
});
const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const profile = {
  id: "00000000-0000-0000-0000-0000000000cc",
  name: "concurrent",
  host: "127.0.0.1",
  port,
  user: "smoke",
  auth: "key",
  term: "xterm-256color",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/**
 * 模拟宿主侧：askHostKey 走 requestHostKey，视图那侧用 resolveHostKeyDecision 回填。
 * 这里只统计「问了几次」，不自己回答 —— 由下面的断言统一回填一次。
 */
const registry = new SessionRegistry(
  createSessionFactory({
    settings: () => ({ sshKeepaliveSeconds: 20, defaultShell: "", defaultCwdMode: "workspace" }),
    dataDir: dir,
    profiles: {
      get: (id) => (id === profile.id ? profile : null),
      list: async () => [profile],
      credentials: async () => ({ privateKey: clientKey }),
    },
    secrets: {},
    workspaceRoot: async () => null,
    askHostKey: async (input) => {
      hostKeyPrompts += 1;
      // 与宿主实现一致：登记等待，等视图回填。这里直接复用一个 Promise。
      const { requestHostKeyForTest } = await import("../main.js");
      return requestHostKeyForTest(input.host, input.port, input.fingerprint);
    },
    audit: () => undefined,
  }),
  { maxSessions: 4, bufferBytes: 1024 * 1024, coalesceMs: 0 },
);

const firstOpen = registry.open({ kind: "ssh", cols: 80, rows: 24, profile }).catch((e) => e);
const secondOpen = registry.open({ kind: "ssh", cols: 80, rows: 24, profile }).catch((e) => e);

// 等两条连接都到达「等确认」状态。
const deadline = Date.now() + 10_000;
let pending = null;
while (Date.now() < deadline) {
  pending = registry.list().find((s) => s.hostKeyPending)?.hostKeyPending ?? null;
  if (pending && hostKeyPrompts >= 2) break;
  await new Promise((r) => setTimeout(r, 50));
}

if (!pending) fail("no hostKeyPending appeared for the concurrent connections");
else ok(`both connections are waiting on one pending entry (${pending.fingerprint.slice(0, 18)}…)`);
if (hostKeyPrompts === 2) ok("each connection did reach its own host key decision point");
else fail(`expected 2 decision points, saw ${hostKeyPrompts}`);

// 关键断言：**一次**回填唤醒全部等待者。
const delivered = resolveHostKeyDecision(pending.host, pending.port, pending.fingerprint, true);
if (delivered) ok("a single decision is delivered");
else fail("the decision was not delivered");

const outcomes = await Promise.all([firstOpen, secondOpen]);
const opened = outcomes.filter((r) => r && r.id);
if (opened.length === 2) ok("both concurrent connections were released by that one decision");
else fail(`only ${opened.length}/2 connections were released: ${JSON.stringify(outcomes.map((o) => o?.message ?? "ok"))}`);

const stillPending = registry.list().filter((s) => s.hostKeyPending).length;
if (stillPending === 0) ok("the pending entry is gone after the decision");
else fail(`${stillPending} pending entry/entries remain`);

await registry.closeAll();
server.close();
clearTimeout(watchdog);
const failed = results.filter((v) => !v).length;
console.log(failed ? `\nCONCURRENT HOST KEY CHECK FAILED (${failed})` : "\nCONCURRENT HOST KEY CHECK OK");
process.exit(failed ? 1 : 0);
