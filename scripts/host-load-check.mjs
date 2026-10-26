/**
 * 用**宿主真实的 sidecar**（app.asar 里的 plugin-host-process.js）载入本插件。
 *
 * 这一步验证的是「装进 PI-Desktop 之后能不能起来」，而不是我们自己写的桩：
 *   · 插件入口能被宿主的 require/import 回退逻辑加载；
 *   · onLoad 拿到 getDataPath/getSettings 后能起来；
 *   · 命令与工具通过宿主的注册通道登记成功；
 *   · onPanelInvoke 的 ping 通道能返回。
 *
 * 用法：node scripts/host-load-check.mjs [宿主 plugin-host-process.js 路径]
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST =
  process.argv[2] ??
  "C:/Users/Sunrise/.pi-desktop/scratch/2218932a-3feb-41e2-8a3e-3c85c635db3e/full/out/main/plugin-host-process.js";
// 优先验证**已安装**的那一份；没装过（例如刚改过插件 id）就退回仓库根目录 ——
// 那里有同一份 main.js + manifest.json，宿主加载路径完全一致，检查才是有效的。
const INSTALLED = "C:/Users/Sunrise/.pi-desktop/plugins/installed/cc.fee.pi-terminal";
const PLUGIN = process.argv[3] ?? (existsSync(join(INSTALLED, "manifest.json")) ? INSTALLED : root);
console.log(`[host-load] plugin path: ${PLUGIN}`);

const dataPath = await mkdtemp(join(tmpdir(), "pi-term-host-"));
const replies = [];
const registered = { commands: [], tools: [] };
// 宿主自己也会调 parentPort.on("message")，但只会覆盖它自己的引用；
// 这是我这边保存的 dispatcher，必须与宿主各自独立。
const listeners = [];
let hostHandler = null;

const handlers = {
  "app.getVersion": () => "0.20.1",
  "plugin.getSettings": () => ({}),
  "plugin.setSettings": () => undefined,
  "plugin.getDataPath": () => dataPath,
  "workspace.get": () => ({ path: "B:/CodeRepo/TypeScript/pi-terminal" }),
  "commands.register": (args) => {
    registered.commands.push(args[0].id);
  },
  "commands.unregister": () => undefined,
  "agent.registerTool": (args) => {
    registered.tools.push(args[0].name);
  },
  "agent.unregisterTool": () => undefined,
  "ui.showToast": () => undefined,
};

globalThis.process.parentPort = {
  on(event, handler) {
    if (event !== "message") return;
    // 宿主注册的 handler 是唯一能 settle()/分发 init 的那个。
    hostHandler = handler;
  },
  postMessage(message) {
    if (message.t === "call") {
      console.log("[host] call", message.api, "id=" + message.id);
      const handler = handlers[message.api];
      if (!handler) {
        replies.push({ id: message.id, ok: false, error: "UNSUPPORTED " + message.api });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.args ?? []))
        .then((value) => {
          console.log("[host] reply", message.api, "->", typeof value);
          replies.push({ id: message.id, ok: true, value });
          setImmediate(() => hostHandler?.({ data: { t: "res", id: message.id, ok: true, value } }));
        })
        .catch((error) => {
          console.log("[host] reply FAIL", message.api, error.message);
          replies.push({ id: message.id, ok: false, error: error.message });
          setImmediate(() => hostHandler?.({ data: { t: "res", id: message.id, ok: false, error: { code: "ERR", message: error.message } } }));
        });
      return;
    }
    if (message.t === "log") {
      console.log(`[plugin ${message.level}] ${message.message}`);
      return;
    }
    if (message.t === "res") {
      replies.push(message);
      // 宿主的 settle() 由 onHostMessage 内部的 message 处理器驱动：
      // 我们必须把响应作为一条 parentPort 消息回灌给它，否则 call() 永远挂住。
      // 异步投递：同步回灌会落在 pending.set 之前，导致后续调用永远收不到回复。
      setImmediate(() => hostHandler?.({ data: message }));
    }
  },
};

const hostModule = await import(pathToFileURL(HOST).href);
if (typeof hostHandler !== "function") {
  console.error("the host sidecar did not register a message handler; cannot drive init");
  process.exit(1);
}
void hostModule;
const manifest = JSON.parse(await readFile(join(PLUGIN, "manifest.json"), "utf8"));
setImmediate(() => hostHandler({ data: { t: "init", id: "i1", pluginId: manifest.id, pluginPath: PLUGIN, manifest } }));

await new Promise((resolve) => setTimeout(resolve, 4000));
console.log("replies:", JSON.stringify(replies).slice(0, 600));
const initReply = replies.find((entry) => entry.id === "i1");
const failures = replies.filter((entry) => entry.ok === false);

console.log(`commands registered: ${registered.commands.length}`);
console.log(`tools registered:    ${registered.tools.length}`);
if (failures.length) {
  console.log("failures:", failures.map((entry) => entry.error).join(" | "));
  process.exitCode = 1;
} else {
  console.log("host init ok");
}

// 再验证一次面板通道：走宿主真实转发路径（panel.invoke）。
const before = replies.length;
setImmediate(() => hostHandler({
  data: {
    t: "call",
    id: "p1",
    method: "panel.invoke",
    payload: { channel: "term.ping", payload: {} },
  },
}));
await new Promise((resolve) => setTimeout(resolve, 1200));
const pingReply = replies.slice(before).find((entry) => entry.id === "p1");
if (pingReply?.ok) {
  console.log("term.ping via host bridge:", JSON.stringify(pingReply.value));
} else {
  console.log("term.ping failed:", JSON.stringify(pingReply));
  process.exitCode = 1;
}

void initReply;
process.exit(process.exitCode ?? 0);
