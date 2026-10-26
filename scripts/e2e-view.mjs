/**
 * 端到端复现：真实视图 + 真实插件主进程（不经过 PI-Desktop 宿主）。
 *
 * 目的：把「新建本地终端后 Tab 被划掉、cwd unknown、内容为空」这个现象
 * 还原成一个可断言的失败，而不是靠读代码猜。
 *
 * 做法：
 *   · 起一个静态服务伺服 test/ 与 views/；
 *   · 在页面里注入 window.pluginBridge，把 invoke 直接转给 require 进来的
 *     main.js（onPanelInvoke），把 on() 变成空订阅；
 *   · 用 chrome-devtools-mcp 打开页面并断言 DOM。
 *
 * 用法：node scripts/e2e-view.mjs [port]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[2] ?? 8791);

/* ── 真实插件主进程 ─────────────────────────────────────────────────── */
const dataDir = await mkdtemp(join(tmpdir(), "pi-term-e2e-"));
const storedSettings = {};
globalThis.pi = {
  plugin: {
    getId: () => "cc.fee.pi-terminal",
    getManifest: () => ({}),
    // 真正的宿主会把设置写进 settings.json；这里用一个对象模拟，否则「改设置再读回来」的路径测不出来。
    getSettings: async () => ({ ...storedSettings }),
    setSettings: async (partial) => Object.assign(storedSettings, partial),
    getDataPath: async () => dataDir,
  },
  workspace: { get: async () => ({ path: root }) },
  commands: { register: async () => {}, unregister: async () => {} },
  agent: { registerTool: async () => {}, unregisterTool: async () => {} },
  ui: { showToast: async () => {}, notify: async () => {} },
};

const plugin = require(join(root, "main.js"));
await plugin.onLoad();
console.log("[e2e] plugin loaded");

/* ── 静态服务 ───────────────────────────────────────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const server = createServer(async (req, res) => {
  // 单一处理器：静态文件与 /invoke 必须二选一。
  // 两个 handler 并存时，静态那个会先对 POST 调 readFile 并写 404，
  // 于是页面只看到 "Failed to fetch" —— 排查时极易被误判成插件坏了。
  if (req.method === "POST" && (req.url ?? "").startsWith("/invoke")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const { channel, payload } = JSON.parse(raw);
        const value = await plugin.onPanelInvoke(channel, payload ?? {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, value }));
      } catch (error) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      }
    });
    return;
  }

  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
    const path = join(root, rel);
    if (!path.startsWith(root)) {
      res.writeHead(403).end("no");
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log(`[e2e] serving http://127.0.0.1:${port}/test/e2e-view.html`);

if (!existsSync(join(root, "test/e2e-view.html"))) {
  console.error("[e2e] test/e2e-view.html is missing");
  process.exit(1);
}
console.log("[e2e] ready; open the URL with chrome-devtools-mcp");
