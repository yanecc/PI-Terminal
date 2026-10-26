/**
 * 端到端冒烟：真实 pty + 会话注册表 + 回环流。
 *
 * 这一步不能靠单测替代：单测证明分帧和缓冲的逻辑对，而这里要证明
 * 「一个真的 shell 起来了、输出真的流过 HTTP 流、kill 真的把进程收掉」。
 * 跑法：npm run build && node scripts/smoke.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envProbeName = "PI_TERMINAL_MAIN_ENV_PROBE";
const envProbeValue = "main-process-env-reached-pty";
const previousEnvProbe = process.env[envProbeName];
process.env[envProbeName] = envProbeValue;

// 直接加载主进程 bundle，把宿主全局替换成最小桩。
const calls = { tools: [], commands: [] };
globalThis.pi = {
  plugin: {
    getId: () => "cc.fee.pi-terminal",
    getManifest: () => ({}),
    getSettings: async () => ({}),
    setSettings: async () => undefined,
    getDataPath: async () => join(root, ".smoke-data"),
  },
  workspace: { get: async () => ({ path: root }) },
  commands: {
    register: async (command) => calls.commands.push(command.id),
    unregister: async () => undefined,
  },
  agent: {
    registerTool: async (tool) => calls.tools.push(tool.name),
    unregisterTool: async () => undefined,
  },
  ui: { showToast: async () => undefined, notify: async () => undefined },
};

const plugin = require(join(root, "main.js"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✔ ${message}`);
}

const inv = (channel, payload) => plugin.onPanelInvoke(channel, payload);

await plugin.onLoad();
ok(`plugin loaded; ${calls.commands.length} commands, ${calls.tools.length} tools registered`);

const ping = await inv("term.ping", {});
if (!ping.ok) fail(`ping failed: ${JSON.stringify(ping)}`);
else ok(`ping ok (relay=${ping.relay}, version=${ping.version})`);
if (ping.environment?.variableCount > 0 && ping.environment.path) {
  ok(`plugin main process sees ${ping.environment.variableCount} environment variables (PATH available)`);
} else {
  fail(`plugin main process environment is missing: ${JSON.stringify(ping.environment)}`);
}

// ── 本地会话 ──────────────────────────────────────────────────────────
const opened = await inv("term.session.open", { kind: "local", cols: 100, rows: 30 });
if (!opened.ok) {
  fail(`could not open a local session: ${JSON.stringify(opened)}`);
  process.exit(1);
}
const sessionId = opened.session.id;
if (previousEnvProbe === undefined) delete process.env[envProbeName];
else process.env[envProbeName] = previousEnvProbe;
ok(`local session ${sessionId.slice(0, 8)}… opened`);

// 流式读取（走真实的回环端口，与视图同一条路径）
let streamed = "";
if (opened.relay) {
  const controller = new AbortController();
  const url = new URL(opened.relay.url);
  url.searchParams.set("from", "1");
  const response = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${opened.relay.token}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const stopAfter = Date.now() + 1500;
  let buffer = "";
  while (Date.now() < stopAfter) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  controller.abort();
  streamed = buffer;
  ok(`loopback stream produced ${buffer.length} bytes of NDJSON`);
  if (!buffer.includes('"t":"hello"')) fail("stream did not send a hello event");
}

// 写入并确认回显 + seq 前进
const write = await inv("term.input", {
  id: sessionId,
  data: Buffer.from("echo PI_TERMINAL_SMOKE_OK\r").toString("base64"),
});
if (!write.ok) fail(`input failed: ${JSON.stringify(write)}`);
await sleep(900);

const read = await inv("term.read", { id: sessionId, fromSeq: 1, maxBytes: 262144 });
if (!read.ok) fail(`read failed: ${JSON.stringify(read)}`);
const text = Buffer.concat(read.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8");
if (text.includes("PI_TERMINAL_SMOKE_OK")) ok("the shell echoed our command back");
else fail(`command echo missing; got ${JSON.stringify(text.slice(-200))}`);
if (read.nextSeq > 1) ok(`seq advanced to ${read.nextSeq}`);

const envProbeCommand =
  process.platform === "win32"
    ? `Write-Output $env:${envProbeName}\r`
    : `printf '%s\\n' "$${envProbeName}"\r`;
const envProbeWrite = await inv("term.input", {
  id: sessionId,
  data: Buffer.from(envProbeCommand).toString("base64"),
});
if (!envProbeWrite.ok) fail(`environment probe input failed: ${JSON.stringify(envProbeWrite)}`);
await sleep(700);
const envProbeRead = await inv("term.read", { id: sessionId, fromSeq: read.nextSeq, maxBytes: 262144 });
const envProbeText = envProbeRead.ok
  ? Buffer.concat(envProbeRead.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8")
  : "";
if (envProbeText.includes(envProbeValue)) ok("the PTY received an environment variable from the plugin main process");
else fail(`the PTY did not receive the environment probe; output=${JSON.stringify(envProbeText.slice(-200))}`);

// resize 之后 stty 应该报告新尺寸
await inv("term.resize", { id: sessionId, cols: 120, rows: 40 });
await sleep(80);
const stty = await inv("term.input", {
  id: sessionId,
  data: Buffer.from(process.platform === "win32" ? "\r" : "stty size\r").toString("base64"),
});
if (!stty.ok) fail("resize/input after resize failed");
await sleep(700);
const afterResize = await inv("term.read", { id: sessionId, fromSeq: read.nextSeq, maxBytes: 262144 });
const resizeText = Buffer.concat(afterResize.chunks.map((c) => Buffer.from(c.data, "base64"))).toString("utf8");
if (process.platform === "win32") {
  ok("resize applied (Windows: ConPTY reports size on its own)");
} else if (resizeText.includes("40 120")) {
  ok("stty reports 40 120 after resize");
} else {
  fail(`unexpected stty output: ${JSON.stringify(resizeText.slice(-120))}`);
}

// ── 会话上限 ──────────────────────────────────────────────────────────
const many = [];
for (let i = 0; i < 9; i += 1) {
  many.push(await inv("term.session.open", { kind: "local", cols: 80, rows: 24 }));
}
const successes = many.filter((result) => result.ok).length;
const limited = many.find((result) => !result.ok && result.code === "LIMIT");
// 限额是 8：已有一个会话 + 最多再开 7 个，第 9 个请求必须被拒。
if (limited && successes === 7) ok(`session limit enforced after ${successes} more sessions (limit 8)`);
else if (limited) fail(`limit rejected the ${successes + 2}th session; expected exactly 8 live`);
else fail("the live-session limit was not enforced");

// ── 关闭与清理 ────────────────────────────────────────────────────────
for (const result of many) {
  if (result.ok) await inv("term.session.close", { id: result.session.id });
}
await inv("term.session.close", { id: sessionId });
const list = await inv("term.sessions.list", {});
if (list.ok && list.sessions.length === 0) ok("all sessions closed");
else fail(`sessions remain: ${JSON.stringify(list.sessions?.map((s) => s.id))}`);

// 关闭后的输入必须是结构化失败，而不是异常
const afterClose = await inv("term.input", { id: sessionId, data: "YQ==" });
if (!afterClose.ok && afterClose.code === "NOT_FOUND") ok("input on a closed session returns NOT_FOUND");
else fail(`unexpected result after close: ${JSON.stringify(afterClose)}`);

// ── 工具面 ────────────────────────────────────────────────────────────
// 工具名**不带** terminal_ 前缀：宿主注册时会加 plugin_local_pi_terminal_。
const EXPECTED_TOOLS = ["read", "send", "wait", "upload", "download", "session", "profile", "setting"];
const registeredNames = [...calls.tools].sort();
const expectedSorted = [...EXPECTED_TOOLS].sort();
if (JSON.stringify(registeredNames) === JSON.stringify(expectedSorted)) {
  ok(`tool surface is exactly: ${EXPECTED_TOOLS.join(", ")}`);
} else {
  fail(`unexpected tool surface: ${JSON.stringify(registeredNames)}`);
}
const opened2 = await inv("term.session.open", { kind: "local", cols: 90, rows: 24 });
const toolList = await invokeTool("session", { action: "list" });
if (toolList.ok) ok(`session action=list sees ${toolList.sessions.length} session(s)`);
if (opened2.ok) await inv("term.session.close", { id: opened2.session.id });

// 命令面：只留 Close All Sessions / Reset All Settings 两个批量动作。
// 命令 id 用插件自己的 `pi-terminal.` 前缀（与标题里的 PI-Terminal 一致）。
const EXPECTED_COMMANDS = ["pi-terminal.closeAll", "pi-terminal.resetSettings"];
const registeredCommands = [...new Set(calls.commands)].sort();
if (JSON.stringify(registeredCommands) === JSON.stringify([...EXPECTED_COMMANDS].sort())) {
  ok(`command surface is exactly: ${EXPECTED_COMMANDS.join(", ")}`);
} else {
  fail(`unexpected command surface: ${JSON.stringify(registeredCommands)}`);
}

// 面板标签：用户一眼看到的那一行必须说明「面板里是什么」（终端），
// 而不是插件名。写成 PI-Terminal 时新建按钮下方会显示一个既非功能
// 也非当前内容的词。
const { manifest } = await import("../dist-manifest.mjs");
const viewTitle = manifest.contributes.views[0]?.title ?? {};
if (viewTitle.en === "Terminal" && viewTitle["zh-CN"] === "终端") {
  ok("the work-panel tab reads Terminal / 终端, not the plugin name");
} else {
  fail(`unexpected view title: ${JSON.stringify(viewTitle)}`);
}
if (viewTitle.en !== manifest.name && viewTitle["zh-CN"] !== manifest.i18n["zh-CN"].name) {
  ok("the tab title is distinct from the plugin name");
} else {
  fail("the tab title duplicates the plugin name");
}

// ── 会话满额时，主机连接自检必须照样可用（回归）──────────────────────
// 旧实现把自检当成普通会话来开，于是「终端开满」后点测试连接会拿到
// 「at most N live sessions」—— 一条与 SSH 无关的错误。
const filled = [];
for (let i = 0; i < 9; i += 1) {
  const result = await inv("term.session.open", { kind: "local", cols: 80, rows: 24 });
  if (result.ok) filled.push(result.session.id);
}
ok(`filled ${filled.length} session slot(s) to hit the limit`);

const probe = await inv("term.profile.test", { id: "no-such-profile" });
if (probe.ok === false && probe.code === "NOT_FOUND") {
  ok("connection test on a full machine reports NOT_FOUND (unknown host), not LIMIT");
} else {
  fail(`connection test with a full session table returned: ${JSON.stringify(probe)}`);
}
const liveAfterProbe = await inv("term.sessions.list", {});
if (liveAfterProbe.ok && liveAfterProbe.sessions.length === filled.length) {
  ok("the connection test did not create or close any session");
} else {
  fail(`the connection test changed the session list: ${JSON.stringify(liveAfterProbe.sessions?.length)}`);
}
// 再来一次「真的会连」的自检：用第一条命令的注册表状态确认它不走 openSession。
const blocked = await inv("term.session.open", { kind: "local", cols: 80, rows: 24 });
if (blocked.ok === false && blocked.code === "LIMIT") ok("a new terminal is still refused while the table is full");
else fail(`expected LIMIT for a new session, got: ${JSON.stringify(blocked)}`);

for (const id of filled) await inv("term.session.close", { id });

async function invokeTool(name, args) {
  // 直接调到注册时传入的 execute，验证真实工具路径（不经过模型）。
  const registered = [];
  const realAgent = globalThis.pi.agent;
  globalThis.pi.agent = {
    registerTool: async (tool) => registered.push(tool),
    unregisterTool: async () => undefined,
  };
  await plugin.onUnload();
  await plugin.onLoad();
  globalThis.pi.agent = realAgent;
  const tool = registered.find((entry) => entry.name === name);
  if (!tool) return { ok: false, message: `tool not registered: ${name}` };
  return tool.execute(args);
}

await plugin.onUnload();
ok("plugin unloaded cleanly");
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE OK");
