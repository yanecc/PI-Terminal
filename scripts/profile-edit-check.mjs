/**
 * 编辑档案的后端验证：`term.profile.save` 带 id 时必须**覆盖**而不是新建，
 * 且「留空 = 保持已保存凭据」「勾选 clear = 删除」两条语义都要对。
 *
 * 这是表单联动的另一半：视图侧只负责显示哪些字段，真正的持久化在这里。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
const ok = (message) => {
  results.push("ok");
  console.log(`✔ ${message}`);
};
const fail = (message) => {
  results.push("fail");
  console.log(`✖ ${message}`);
};

// 最小宿主桩：只需要数据目录与设置。
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const dataDir = await mkdtemp(join(tmpdir(), "pi-term-profile-"));

globalThis.pi = {
  plugin: {
    getId: () => "cc.fee.pi-terminal",
    getManifest: () => ({}),
    getSettings: async () => ({}),
    setSettings: async () => undefined,
    getDataPath: async () => dataDir,
  },
  workspace: { get: async () => ({ path: root }) },
  commands: { register: async () => undefined, unregister: async () => undefined },
  agent: { registerTool: async () => undefined, unregisterTool: async () => undefined },
  ui: { showToast: async () => undefined, notify: async () => undefined },
};

const plugin = (await import("node:module")).createRequire(import.meta.url)(join(root, "main.js"));
const invoke = (channel, payload) => plugin.onPanelInvoke(channel, payload);

await plugin.onLoad();

// 1) 新建：密码认证，带密码
const created = await invoke("term.profile.save", {
  name: "prod",
  host: "10.0.0.5",
  port: 22,
  user: "deploy",
  auth: "password",
  password: "s3cret",
});
if (!created.ok) {
  fail(`create failed: ${JSON.stringify(created)}`);
  process.exit(1);
}
const id = created.profile.id;
if (created.profile.hasPassword) ok(`created a password profile (${id.slice(0, 8)}…)`);
else fail("the saved password was not recorded");

// 2) 编辑：只改端口与名字，密码留空 → 必须仍是「有密码」，且 id 不变
const edited = await invoke("term.profile.save", {
  id,
  name: "prod web",
  host: "10.0.0.5",
  port: 2222,
  user: "deploy",
  auth: "password",
  password: "",
});
if (!edited.ok) {
  fail(`edit failed: ${JSON.stringify(edited)}`);
} else {
  if (edited.profile.id === id) ok("editing keeps the same profile id (updates, not a new host)");
  else fail(`a new id was created on edit: ${edited.profile.id}`);
  if (edited.profile.port === 2222) ok("the edited port was persisted");
  else fail(`port not updated: ${edited.profile.port}`);
  if (edited.profile.hasPassword) ok("leaving the password empty keeps the saved one");
  else fail("editing with an empty password silently dropped it");
}

const list = await invoke("term.profile.list", {});
if (list.ok && list.profiles.length === 1) ok("exactly one profile exists after the edit");
else fail(`expected 1 profile, got ${list.ok ? list.profiles.length : JSON.stringify(list)}`);

// 3) 切换到 key：私钥路径入库，密码仍在（只是不再被使用）
const asKey = await invoke("term.profile.save", {
  id,
  host: "10.0.0.5",
  port: 2222,
  user: "deploy",
  auth: "key",
  privateKeyPath: "~/.ssh/id_ed25519",
});
if (asKey.ok && asKey.profile.auth === "key" && asKey.profile.privateKeyPath) {
  ok("switching to key auth stores the key path");
} else {
  fail(`switch to key failed: ${JSON.stringify(asKey)}`);
}

// 4) 显式清除密码
const cleared = await invoke("term.profile.save", {
  id,
  host: "10.0.0.5",
  port: 2222,
  user: "deploy",
  auth: "key",
  privateKeyPath: "~/.ssh/id_ed25519",
  clearPassword: true,
});
if (cleared.ok && !cleared.profile.hasPassword) ok("clearPassword actually forgets the secret");
else fail(`clearPassword did not work: ${JSON.stringify(cleared.profile ?? cleared)}`);

// 4.5) 分组：保存后可读回；清空表示移出分组
const grouped = await invoke("term.profile.save", {
  id, host: "10.0.0.5", port: 2222, user: "deploy", auth: "key",
  privateKeyPath: "~/.ssh/id_ed25519", group: "prod",
});
if (grouped.ok && grouped.profile.group === "prod") ok("the group is persisted");
else fail(`group not saved: ${JSON.stringify(grouped.profile?.group)}`);

const regrouped = await invoke("term.profile.save", {
  id, host: "10.0.0.5", port: 2222, user: "deploy", auth: "key",
  privateKeyPath: "~/.ssh/id_ed25519", group: "",
});
if (regrouped.ok && !regrouped.profile.group) ok("an empty group moves the host back to Ungrouped");
else fail(`group not cleared: ${JSON.stringify(regrouped.profile?.group)}`);

// 5) 编辑时把 key 换成 agent：私钥路径必须被清掉，避免留下隐藏配置
const asAgent = await invoke("term.profile.save", {
  id,
  host: "10.0.0.5",
  port: 2222,
  user: "deploy",
  auth: "agent",
  privateKeyPath: "",
});
if (asAgent.ok && !asAgent.profile.privateKeyPath) ok("switching to ssh-agent clears the stale key path");
else fail(`stale key path survived: ${JSON.stringify(asAgent.profile?.privateKeyPath)}`);

await plugin.onUnload();
await rm(dataDir, { recursive: true, force: true });

const failed = results.filter((result) => result === "fail").length;
console.log(failed ? `\nPROFILE EDIT FAILED (${failed})` : "\nPROFILE EDIT OK");
process.exit(failed ? 1 : 0);
