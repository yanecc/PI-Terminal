/**
 * 纯逻辑单测。
 *
 * 只测「错了会静默产生坏数据」的地方：环形缓冲的裁剪与 seq、脱敏是否会漏、
 * known_hosts 的指纹判定、回环分帧、设置回落。真实 pty/SSH 的行为由集成
 * 脚本验证，这里不重复。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

// theme.ts 会读 window.matchMedia（判断系统配色偏好）。Node 里没有浏览器环境，
// 这里注入最小桩：默认「非浅色」，个别用例再临时改写。
let systemPrefersLight = false;
globalThis.window = {
  matchMedia: (query) => ({ matches: query.includes("light") ? systemPrefersLight : !systemPrefersLight }),
};
import {
  RingBuffer,
  redactSecrets,
  KnownHosts,
  REDACTED,
  parseKnownHosts,
  fingerprintOf,
  hostKeyName,
  encodeEvent,
  EventDecoder,
  sanitizeSettings,
  DEFAULT_SETTINGS,
  expandHome,
  buildEnv,
  resolveShell,
  resolveBase,
  mergePathLists,
  expandEnvRefs,
  powershellModuleRoots,
  resolveLocale,
  t,
  setLocale,
  messagesFor,
  groupProfiles,
  normalizeFamilies,
  coerceSettingsPatch,
  SETTINGS_KEYS,
  normalizeProfileInput,
  SessionRegistry,
  pickMonospaceFamilies,
} from "./.build/test-bundle.mjs";

/* ── Shell environment ────────────────────────────────────────────────── */

test("buildEnv: child environment contains one effective PATH entry", async () => {
  const env = await buildEnv({ mergeSystemPath: false });
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
  assert.equal(pathKeys.length, 1);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.TEMP, process.env.TEMP);
  if (process.platform === "win32") {
    const keys = Object.keys(env);
    assert.deepEqual(keys, [...keys].sort((left, right) => {
      const a = left.toUpperCase();
      const b = right.toUpperCase();
      return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
    }));
  }
});

test("resolveShell: uses the child PATH and prefers Windows PowerShell", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-terminal-shell-"));
  try {
    if (process.platform === "win32") {
      const powershell = join(temp, "powershell.exe");
      await writeFile(powershell, "");
      const resolved = resolveShell("", { PATH: temp, PATHEXT: ".EXE" });
      assert.equal(normalize(resolved.argv[0]), normalize(powershell));
      assert.deepEqual(resolved.argv.slice(1), ["-NoLogo"]);
      assert.equal(resolved.source, "detected");
    } else {
      const resolved = resolveShell("", { SHELL: process.execPath, PATH: "" });
      assert.deepEqual(resolved, { argv: [process.execPath], source: "detected" });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

/*
 * 设置里显式填命令行时，必须和「留空自动探测」产出同一条命令行。
 *
 * 这里曾经有个真实缺陷：填 `powershell` 直接返回 `["powershell"]`，既没有解析成
 * 绝对路径，也没有 `-NoLogo`；而留空时得到的是 `[<abs>, "-NoLogo"]`。同一个
 * 用户意图、两条不同的命令行，PowerShell 的初始化行为因此不一致 —— 用户看到
 * 的就是「留空没事，填了 powershell 就读不到环境变量」。
 */
test("resolveShell: an explicitly configured shell resolves like auto-detection", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-terminal-shell-explicit-"));
  try {
    if (process.platform === "win32") {
      const powershell = join(temp, "powershell.exe");
      await writeFile(powershell, "");
      const env = { PATH: temp, PATHEXT: ".EXE" };
      // Windows 路径比较要忽略大小写：findOnPath 用 PATHEXT 里写的大写扩展名
      // 拼出候选文件名（`powershell.EXE`），与原始文件的 `.exe` 等价。
      const samePath = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

      // 只写命令名：必须解析成绝对路径并带上 -NoLogo。
      const byName = resolveShell("powershell", env);
      assert.ok(samePath(byName.argv[0], powershell), `expected ${byName.argv[0]} to resolve to ${powershell}`);
      assert.deepEqual(byName.argv.slice(1), ["-NoLogo"]);
      assert.equal(byName.source, "settings");

      // 自动探测出的结果必须与之一致。
      const detected = resolveShell("", env);
      assert.deepEqual(
        [normalize(detected.argv[0]).toLowerCase(), ...detected.argv.slice(1)],
        [normalize(byName.argv[0]).toLowerCase(), ...byName.argv.slice(1)],
      );

      // 写绝对路径：原样采用，且仍然补上 -NoLogo。
      const byPath = resolveShell(powershell, env);
      assert.equal(samePath(byPath.argv[0], powershell), true);
      assert.deepEqual(byPath.argv.slice(1), ["-NoLogo"]);
      assert.throws(
        () => resolveShell("definitely-not-a-shell", { PATH: "/nonexistent" }),
        /not found on PATH/,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
/* ── RingBuffer ───────────────────────────────────────────────────────── */

test("RingBuffer: seq 单调递增，read 从指定位置续读", () => {
  const buffer = new RingBuffer(1024 * 1024);
  const s1 = buffer.push(Buffer.from("hello "));
  const s2 = buffer.push(Buffer.from("world"));
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(buffer.latestSeq, 2);

  const all = buffer.read(1, 1024);
  assert.deepEqual(
    all.chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString()),
    ["hello ", "world"],
  );
  assert.equal(all.nextSeq, 3);

  const tail = buffer.read(2, 1024);
  assert.deepEqual(
    tail.chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString()),
    ["world"],
  );
});

test("RingBuffer: 超过上限时从最旧开始丢，并报告 truncated", () => {
  const buffer = new RingBuffer(4096);
  for (let i = 0; i < 10; i += 1) {
    buffer.push(Buffer.alloc(1024, i));
  }
  // 至少要保留一块，且总量不超过上限。
  assert.ok(buffer.totalBytes <= 4096, `totalBytes=${buffer.totalBytes}`);
  assert.ok(buffer.earliestSeq > 1, "older chunks should have been dropped");

  const tooOld = buffer.read(1, 1024 * 64);
  assert.equal(tooOld.truncated, true);

  const fromEarliest = buffer.read(buffer.earliestSeq, 1024 * 64);
  assert.equal(fromEarliest.truncated, false);
  assert.ok(fromEarliest.chunks.length > 0);
});

test("RingBuffer: maxBytes 预算不会返回半块（避免切坏多字节字符）", () => {
  const buffer = new RingBuffer(1024 * 1024);
  buffer.push(Buffer.from("一二三")); // 9 字节
  buffer.push(Buffer.from("四五六")); // 9 字节
  const read = buffer.read(1, 10);
  // 第一块（9 字节）放得下，第二块会超出预算 → 只返回第一块。
  assert.equal(read.chunks.length, 1);
  assert.equal(Buffer.from(read.chunks[0].data, "base64").toString(), "一二三");
});

test("RingBuffer: read 起点超过最新 seq 时返回空且 nextSeq 不倒退", () => {
  const buffer = new RingBuffer(4096);
  buffer.push(Buffer.from("a"));
  const read = buffer.read(99, 1024);
  assert.equal(read.chunks.length, 0);
  assert.ok(read.nextSeq >= 2);
});

test("RingBuffer: 上限低于 4KiB 直接拒绝（防止配置错误变成静默丢数据）", () => {
  assert.throws(() => new RingBuffer(1024));
});

/* ── 脱敏 ─────────────────────────────────────────────────────────────── */

test("redactSecrets: 常见密钥形态一律遮住", () => {
  const samples = [
    "AWS_SECRET_ACCESS_KEY=abcd1234efgh",
    "export GITHUB_TOKEN=ghp_1234567890abcdefghij",
    "password=hunter2",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "api_key: 'sk-live-abcdefgh'",
    "ghp_1234567890abcdefghijklmnopqrstuvwx",
  ];
  for (const sample of samples) {
    const { text } = redactSecrets(sample);
    assert.ok(text.includes(REDACTED), `not redacted: ${sample} -> ${text}`);
  }
});

test("redactSecrets: 普通输出不被改动", () => {
  const plain = "npm warn deprecated foo@1.0.0\n$ ls -la\ntotal 12\n";
  const { text, redactions } = redactSecrets(plain);
  assert.equal(text, plain);
  assert.equal(redactions, 0);
});

/* ── known_hosts ──────────────────────────────────────────────────────── */

test("parseKnownHosts: 跳过注释、通配符与哈希条目", () => {
  const entries = parseKnownHosts(
    [
      "# comment",
      "example.com ssh-ed25519 AAAAB3Nza",
      "[git.example.com]:2222 ssh-rsa AAAAB3Nza",
      "*.internal ssh-rsa AAAAB3Nza",
      "|1|hash==|salt== ssh-ed25519 AAAAB3Nza",
      "",
    ].join("\n"),
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].hosts, ["example.com"]);
  assert.deepEqual(entries[1].hosts, ["[git.example.com]:2222"]);
});

test("hostKeyName: 非 22 端口用 OpenSSH 的方括号写法", () => {
  assert.equal(hostKeyName("host", 22), "host");
  assert.equal(hostKeyName("host", 2222), "[host]:2222");
});

test("fingerprintOf: 稳定的 SHA256 base64 且无填充", () => {
  const key = Buffer.from("some-raw-host-key");
  const fingerprint = fingerprintOf(key);
  assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(fingerprint, fingerprintOf(Buffer.from("some-raw-host-key")));
  assert.notEqual(fingerprint, fingerprintOf(Buffer.from("other-key")));
});

test("KnownHosts.verify: 只有同类型的旧条目才算指纹变化", () => {
  // 同一台主机同时有 ed25519（用户以前用 OpenSSH 连过）与这次协商出来的 rsa。
  const ed25519 = Buffer.from("ed25519-key-material");
  const rsa = Buffer.from("rsa-key-material");
  const known = KnownHosts.fromText(
    [`example.com ssh-ed25519 ${ed25519.toString("base64")}`, `example.com ssh-rsa ${rsa.toString("base64")}`].join("\n"),
  );

  // 1) 完全相同的 key → trusted
  assert.equal(known.verify("example.com", 22, ed25519, "ssh-ed25519").status, "trusted");
  assert.equal(known.verify("example.com", 22, rsa, "ssh-rsa").status, "trusted");

  // 2) 新算法首次出现（记录里只有 ed25519，这次是 rsa）→ unknown，不是 changed
  const edOnly = KnownHosts.fromText(`example.com ssh-ed25519 ${ed25519.toString("base64")}`);
  const fresh = Buffer.from("brand-new-rsa-key");
  assert.equal(
    edOnly.verify("example.com", 22, fresh, "ssh-rsa").status,
    "unknown",
    "a different key type must not be reported as a changed fingerprint",
  );

  // 3) 同类型但内容不同 → changed（真正的替换必须被拦住）
  const replaced = Buffer.from("rotated-ed25519-key");
  const changed = edOnly.verify("example.com", 22, replaced, "ssh-ed25519");
  assert.equal(changed.status, "changed");
  assert.equal(changed.previous, fingerprintOf(ed25519));

  // 4) 机型未知（老调用方没传 keyType）时按冲突处理：宁严不漏
  assert.equal(edOnly.verify("example.com", 22, fresh).status, "changed");
});

/* ── 回环协议分帧 ─────────────────────────────────────────────────────── */

test("EventDecoder: 一行被切成多块也能还原", () => {
  const events = [];
  const decoder = new EventDecoder((event) => events.push(event));
  const line = encodeEvent({ t: "data", seq: 3, data: "aGk=" });
  for (const char of line) decoder.push(char);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 3);
});

test("EventDecoder: 一个块里多行全部处理", () => {
  const events = [];
  const decoder = new EventDecoder((event) => events.push(event));
  decoder.push(encodeEvent({ t: "hello", session: "s", seq: 1, status: "running" }));
  decoder.push(encodeEvent({ t: "ping", at: 1 }));
  assert.equal(events.length, 2);
  assert.equal(events[0].t, "hello");
});

test("EventDecoder: 坏行交给 onError 而不是静默丢弃", () => {
  const seen = [];
  const decoder = new EventDecoder(
    () => {},
    (line) => seen.push(line),
  );
  decoder.push("not json\n");
  assert.deepEqual(seen, ["not json"]);
});

/* ── 设置回落 ─────────────────────────────────────────────────────────── */

test("sanitizeSettings: 坏值全部回落到默认", () => {
  const result = sanitizeSettings({
    defaultShell: 42,
    scrollback: "many",
    fontSize: 999,
    bufferBytes: 1,
    maxSessions: 0,
    relayEnabled: "nope",
    defaultCwdMode: "elsewhere",
  });
  assert.equal(result.defaultShell, DEFAULT_SETTINGS.defaultShell);
  assert.equal(result.scrollback, DEFAULT_SETTINGS.scrollback);
  assert.equal(result.fontSize, 28, "fontSize is clamped, not defaulted");
  assert.equal(result.bufferBytes, 256 * 1024, "bufferBytes is clamped to the floor");
  assert.equal(result.maxSessions, 1, "maxSessions is clamped to the floor");
  assert.equal(result.relayEnabled, DEFAULT_SETTINGS.relayEnabled);
  assert.equal(result.defaultCwdMode, "workspace");
});

test("sanitizeSettings: 合法值原样保留", () => {
  const result = sanitizeSettings({
    defaultShell: "/bin/zsh",
    defaultCwdMode: "home",
    scrollback: 12000,
    bufferBytes: 4 * 1024 * 1024,
    maxSessions: 4,
    fontSize: 14,
    fontFamily: "Fira Code",
    cursorBlink: false,
    confirmMultilinePaste: false,
    relayEnabled: false,
    sshKeepaliveSeconds: 45,
  });
  assert.equal(result.defaultShell, "/bin/zsh");
  assert.equal(result.defaultCwdMode, "home");
  assert.equal(result.scrollback, 12000);
  assert.equal(result.maxSessions, 4);
  assert.equal(result.fontFamily, "Fira Code");
  assert.equal(result.cursorBlink, false);
  assert.equal(result.relayEnabled, false);
  assert.equal(result.sshKeepaliveSeconds, 45);
});

/* ── 路径 ─────────────────────────────────────────────────────────────── */

test("expandHome: 只展开开头的 ~", () => {
  const expanded = expandHome("~/keys/id_ed25519");
  assert.ok(expanded.endsWith("keys/id_ed25519") || expanded.endsWith("keys\\id_ed25519"));
  assert.ok(expanded.startsWith("/") || /^[A-Za-z]:/.test(expanded), `unexpected: ${expanded}`);
  assert.equal(expandHome("/abs/path/~nope"), "/abs/path/~nope");
});

/* ── 主题解析（明暗跟随宿主）───────────────────────────────────────────── */

test("resolveBase: 宿主显式 light/dark 时原样采用", () => {
  assert.equal(resolveBase({ base: "light" }), "light");
  assert.equal(resolveBase({ base: "dark" }), "dark");
});

test("resolveBase: system / 缺失 / 伪造值都回落到系统配色偏好", () => {
  const restore = systemPrefersLight;
  systemPrefersLight = true;
  // 这三个输入必须得到**同一个**答案，否则浅色系统上会出现深色面板。
  const fromSystem = resolveBase({ base: "system" });
  const fromMissing = resolveBase(null);
  const fromUnknown = resolveBase({ base: "plugin:something" });
  assert.equal(fromSystem, fromMissing);
  assert.equal(fromMissing, fromUnknown);
  // 系统偏好浅色时，三者都必须得到 light。
  assert.equal(fromSystem, "light");
  assert.equal(fromMissing, "light");
  assert.equal(fromUnknown, "light");
  systemPrefersLight = restore;
});


/* ── PATH 合并（系统 PATH 自动加载）────────────────────────────────────── */

test("mergePathLists: 进程条目优先，系统条目补在后面", () => {
  const merged = mergePathLists("C:\A;C:\B", "C:\B;C:\C");
  const parts = merged.split(";");
  assert.deepEqual(parts, ["C:\A", "C:\B", "C:\C"]);
});

test("mergePathLists: 去重忽略大小写与结尾反斜杠（Windows 语义）", () => {
  const merged = mergePathLists("C:\Tools\\", "c:\tools;C:\Other");
  const parts = merged.toLowerCase();
  // 同一条只保留一次；大小写不同不该追加第二份。
  assert.equal(parts.split(";").filter((p) => p.replace(/\+$/, "") === "c:\tools").length, 1);
  assert.ok(parts.includes("c:\other"));
});

test("mergePathLists: 空当前值也能只要系统条目", () => {
  assert.equal(mergePathLists(undefined, "C:\Only"), "C:\Only");
  assert.equal(mergePathLists("", ""), "");
});

/*
 * REG_EXPAND_SZ 的展开。
 *
 * 注册表里的 PATH / PSModulePath 存的是 `%ProgramFiles%\...` 这种未展开的值；
 * PowerShell 进程常把它原样带进 `$env:`，于是用户会看到一条永远不存在的目录，
 * 同时 profile 里的 Import-Module 因为模块目录没被解析到而失败。
 * 这里锁定「先展开、再去重、坏条目丢弃」这条链。
 */
test("mergePathLists: 未展开的 %VAR% 先展开，合并时不会重复", () => {
  if (process.platform !== "win32") {
    assert.equal(expandEnvRefs("%ProgramFiles%\\x"), "%ProgramFiles%\\x");
    return;
  }
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
  assert.ok(programFiles, "the test needs ProgramFiles to exist");

  // 单条展开：大小写不敏感的变量名也要认。
  assert.equal(expandEnvRefs("%ProgramFiles%\\WindowsPowerShell\\Modules"), `${programFiles}\\WindowsPowerShell\\Modules`);
  assert.equal(expandEnvRefs("%PROGRAMFILES%\\x"), `${programFiles}\\x`);
  // 未知变量保持原样，交给合并阶段丢弃。
  assert.equal(expandEnvRefs("%PI_TEST_NOPE%\\x"), "%PI_TEST_NOPE%\\x");

  // 合并：未展开条目与已展开条目指向同一目录时必须只留一条。
  const merged = mergePathLists(
    "%ProgramFiles%\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32",
    `${programFiles}\\WindowsPowerShell\\Modules;A:\\Scoop\\modules`,
  );
  const entries = merged.split(";").filter(Boolean);
  assert.equal(
    entries.filter((e) => e.toLowerCase().endsWith("windowspowershell\\modules")).length,
    1,
    `expected one WindowsPowerShell\\Modules entry, got: ${merged}`,
  );
  // 展开失败、变量又不存在的条目必须被丢掉，不能留在 PATH 里。
  assert.equal(/%[^%]+%/.test(merged), false, `unexpanded variable survived: ${merged}`);
  assert.ok(entries.some((e) => e.toLowerCase().includes("scoop\\modules")));
});

/*
 * PowerShell 自带模块根的兜底。
 *
 * 宿主的 sidecar 常常只带 SystemRoot 这类少数变量（实测审计里
 * inboundPsModuleEntries=0），此时 env.ProgramFiles 不存在。早期实现直接跳过
 * 这一条，PSModulePath 就只剩 3 条、缺 `C:\Program Files\WindowsPowerShell\Modules`，
 * 于是 profile 里的 Import-Module 连锁失败、$Error.Count 非 0。
 *
 * 这里锁定：即使传入的环境只有 SystemRoot，两条模块根也要能推出来。
 */
test("powershellModuleRoots: 环境只剩 SystemRoot 时仍补全两条模块根", () => {
  if (process.platform !== "win32") {
    assert.equal(powershellModuleRoots({}), "");
    return;
  }
  const roots = powershellModuleRoots({ SystemRoot: "C:\\WINDOWS" })
    .split(";")
    .filter(Boolean);
  // 必须包含 PowerShell 内置模块目录（v1.0\Modules）——缺它 Import-Module 就崩。
  assert.ok(
    roots.some((r) => /system32\\windowspowershell\\v1\.0\\modules$/i.test(r)),
    `missing the v1.0 Modules root: ${JSON.stringify(roots)}`,
  );
  // ProgramFiles 不在传入环境里时，应按 SystemRoot 的盘符推出来。
  if (process.env.ProgramFiles) {
    assert.ok(
      roots.some((r) => /program files\\windowspowershell\\modules$/i.test(r)),
      `missing the Program Files Modules root: ${JSON.stringify(roots)}`,
    );
  }
  // 显式给了 ProgramFiles 时优先用它，且仍然带 v1.0 那条。
  const withPf = powershellModuleRoots({
    SystemRoot: "C:\\WINDOWS",
    ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
  });
  assert.ok(withPf.split(";").filter(Boolean).length >= 1);
});
/* ── 语言 ─────────────────────────────────────────────────────────────── */

test("resolveLocale: 各种中文变体都归到 zh-CN", () => {
  for (const raw of ["zh", "zh-CN", "zh-TW", "zh-Hant", "ZH-hans"]) {
    assert.equal(resolveLocale(raw), "zh-CN", raw);
  }
});

test("resolveLocale: 英文与其他语言", () => {
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("ja-JP"), "en", "unsupported languages fall back to English");
  assert.equal(resolveLocale(""), "en");
  assert.equal(resolveLocale(null), "en");
});

test("messagesFor: 中英词表的键集合完全一致", () => {
  // 这是最容易腐化的地方：加了一句中文却忘了英文，用户在另一种语言下会看到键名。
  const en = Object.keys(messagesFor("en")).sort();
  const zh = Object.keys(messagesFor("zh-CN")).sort();
  assert.deepEqual(zh, en);
});

test("messagesFor: 没有空字符串条目", () => {
  for (const locale of ["en", "zh-CN"]) {
    for (const [key, value] of Object.entries(messagesFor(locale))) {
      assert.ok(value.trim().length > 0, `${locale}:${key} is empty`);
    }
  }
});

test("t: 占位符替换与缺省回退", () => {
  setLocale("en");
  assert.match(t("status.copied", { count: 42 }), /42/);
  setLocale("zh-CN");
  assert.match(t("status.copied", { count: 42 }), /42/);
  // 未知占位符原样保留，不抛异常。
  assert.ok(t("status.copied", {}).includes("{count}"));
  setLocale("en");
});

/* ── 分组 ─────────────────────────────────────────────────────────────── */

test("groupProfiles: 具名分组按字母序，未分组永远在最后", () => {
  const profiles = [
    { id: "1", name: "b", group: "prod" },
    { id: "2", name: "a", group: "dev" },
    { id: "3", name: "z" },
    { id: "4", name: "a2", group: "prod" },
  ];
  const groups = groupProfiles(profiles);
  assert.deepEqual(groups.map((g) => g.group), ["dev", "prod", ""]);
  const prod = groups.find((g) => g.group === "prod");
  assert.deepEqual(prod.items.map((p) => p.name), ["a2", "b"]);
});

test("groupProfiles: 只有未分组时不产生空分组", () => {
  const groups = groupProfiles([{ id: "1", name: "solo" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].group, "");
});

test("groupProfiles: 分组名两端空格视为同一组", () => {
  const groups = groupProfiles([
    { id: "1", name: "a", group: "prod" },
    { id: "2", name: "b", group: "  prod  " },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});

/* ── 字体 ─────────────────────────────────────────────────────────────── */

/* ── 字体（font-list 的 monospace 标记 + canvas 兜底）──────────────────── */

test("normalizeFamilies: 全部族名去重，monospace=true 单独收一组", () => {
  const fonts = [
    { familyName: "Consolas", monospace: true },
    { familyName: "Arial", monospace: false },
    { familyName: "Cascadia Mono", monospace: true },
    { familyName: "consolas", monospace: true },
    { familyName: "   ", monospace: true },
    null,
  ];
  const result = normalizeFamilies(fonts);
  assert.deepEqual(result.families, ["Arial", "Cascadia Mono", "Consolas"]);
  assert.deepEqual(result.monospace, ["Cascadia Mono", "Consolas"]);
});

test("normalizeFamilies: 标记整片为 false 时 monospace 为空（交给视图兜底）", () => {
  const result = normalizeFamilies([{ familyName: "Consolas", monospace: false }]);
  assert.deepEqual(result.families, ["Consolas"]);
  assert.deepEqual(result.monospace, []);
});

test("pickMonospaceFamilies: 只保留已装且等宽的族", () => {
  const FALLBACK = 10;
  const widths = { Consolas: 8, Arial: 11, "Missing Mono": FALLBACK };
  const measure = (font, text) => {
    const family = /"([^"]*)"/.exec(font)?.[1] ?? "";
    const width = widths[family] ?? FALLBACK;
    if (text === "MMMMMMMMMM") return width;
    return family === "Consolas" ? width : width * 0.4;
  };
  assert.deepEqual(pickMonospaceFamilies(Object.keys(widths), measure), ["Consolas"]);
});

/* ── 设置补丁与档案归一化（模型工具的入参校验）────────────────────────── */

test("coerceSettingsPatch: 合法键通过，未知键与错类型各自报问题", () => {
  const ok = coerceSettingsPatch({ fontSize: 15, cursorBlink: false, defaultShell: " nu " });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.patch.fontSize, 15);
  assert.equal(ok.patch.cursorBlink, false);
  assert.equal(ok.patch.defaultShell, "nu", "string settings are trimmed");

  const bad = coerceSettingsPatch({ fontSize: "big", noSuchKey: 1, defaultCwdMode: "elsewhere", relayEnabled: "yes" });
  assert.equal(Object.keys(bad.patch).length, 0, "nothing usable should survive");
  assert.equal(bad.problems.length, 4, JSON.stringify(bad.problems));
  assert.ok(bad.problems.some((p) => p.includes("unknown setting: noSuchKey")));
});

test("coerceSettingsPatch: 非对象输入直接报错而不是崩", () => {
  assert.deepEqual(coerceSettingsPatch(null).problems, ["settings must be an object"]);
  assert.deepEqual(coerceSettingsPatch([1, 2]).problems, ["settings must be an object"]);
});

test("SETTINGS_KEYS: 与 DEFAULT_SETTINGS 的键一一对应", () => {
  assert.deepEqual([...SETTINGS_KEYS].sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test("normalizeProfileInput: 截断、去空白，空串保留语义", () => {
  const input = normalizeProfileInput({
    id: "  abc  ",
    name: "  prod web ",
    group: "",
    host: " example.com ",
    port: 2222,
    user: " deploy ",
    auth: "key",
    privateKeyPath: "",
    keepaliveSeconds: 45,
    password: "hunter2",
    secret: "ignored",
  });
  assert.equal(input.id, "abc");
  assert.equal(input.name, "prod web");
  assert.equal(input.group, "", "empty group means move out of the group");
  assert.equal(input.host, "example.com");
  assert.equal(input.port, 2222);
  assert.equal(input.privateKeyPath, "", "empty key path must clear the stored one");
  assert.equal(input.auth, "key");
  assert.equal(input.password, "hunter2");
  assert.equal(input.clearPassword, false);
  assert.equal("secret" in input, false, "unknown fields are dropped");
});

test("normalizeProfileInput: 非法 auth 归成 undefined（保持原值，而不是写死 agent）", () => {
  assert.equal(normalizeProfileInput({ auth: "magic" }).auth, undefined);
  assert.equal(normalizeProfileInput({}).auth, undefined);
  assert.equal(normalizeProfileInput({ port: Number.NaN }).port, undefined);
});

/* ── 活动会话标记（模型工具的 active 字段）────────────────────────────── */

test("SessionRegistry: setActive 标记当前会话，关闭时自动清除", async () => {
  const registry = new SessionRegistry(
    async ({ handle }) => {
      handle.describe({ cwd: "/tmp" });
      handle.setStatus("running");
      return {
        transport: {
          kind: "local",
          write: () => undefined,
          resize: () => undefined,
          kill: async () => undefined,
          probeCwd: async () => "/tmp",
        },
      };
    },
    { maxSessions: 4, bufferBytes: 1024 * 1024, coalesceMs: 0 },
  );

  const first = await registry.open({ kind: "local", cols: 80, rows: 24 });
  const second = await registry.open({ kind: "local", cols: 80, rows: 24 });
  assert.equal(registry.list().filter((s) => s.active).length, 0, "no session is active until the view reports one");

  registry.setActive(first.id);
  assert.deepEqual(registry.list().filter((s) => s.active).map((s) => s.id), [first.id]);
  assert.equal(registry.get(second.id)?.active, false);

  // 未知 id 归一成「没有活动会话」，不能让列表指向不存在的会话。
  registry.setActive("00000000-0000-0000-0000-000000000000");
  assert.equal(registry.list().filter((s) => s.active).length, 0);

  registry.setActive(first.id);
  await registry.close(first.id);
  assert.equal(registry.list().filter((s) => s.active).length, 0, "closing the active session clears the flag");
  await registry.closeAll();
});

/* ── 连接自检不占会话名额 ─────────────────────────────────────────────── */

test("SessionRegistry: 会话满额后 open 被拒，但自检（不经注册表）照样能跑", async () => {
  const registry = new SessionRegistry(
    async ({ handle }) => {
      handle.describe({ cwd: "/tmp" });
      handle.setStatus("running");
      return {
        transport: {
          kind: "local",
          write: () => undefined,
          resize: () => undefined,
          kill: async () => undefined,
          probeCwd: async () => "/tmp",
        },
      };
    },
    { maxSessions: 1, bufferBytes: 1024 * 1024, coalesceMs: 0 },
  );

  await registry.open({ kind: "local", cols: 80, rows: 24 });
  await assert.rejects(
    () => registry.open({ kind: "local", cols: 80, rows: 24 }),
    (error) => error.code === "LIMIT",
    "the second session must hit the live-session limit",
  );

  // 自检是一个普通 Promise，和注册表毫无关系 —— 这正是修复点：
  // 它不再开会话，所以「终端开满」不会让「测试连接」跟着失败。
  const probe = async () => ({ fingerprint: "SHA256:test" });
  assert.deepEqual(await probe("any-profile"), { fingerprint: "SHA256:test" });
  assert.equal(registry.liveCount(), 1, "a probe must not consume a session slot");
  assert.equal(registry.ids().length, 1);
  await registry.closeAll();
});
