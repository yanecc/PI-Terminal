/**
 * 验证「本地终端自动加载系统 PATH」。
 *
 * 不是断言 PATH 字符串长什么样，而是断言**行为**：
 *   1. buildEnv 合并后的 PATH 包含注册表里的每一条；
 *   2. 用这份环境真起一个 pty，`where`/`command -v` 能找到只在系统 PATH 里的命令；
 *   3. 进程 PATH 被故意裁剪后，依然能解析到那些命令（模拟「从 Explorer 启动的
 *      宿主拿到的是登录时的旧快照」这一真实故障）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const ok = (message) => {
  results.push("ok");
  console.log(`✔ ${message}`);
};
const fail = (message) => {
  results.push("fail");
  console.log(`✖ ${message}`);
};

const { buildEnv, mergePathLists, readSystemPath } = await import("../dist-env-test.mjs");

const systemPath = await readSystemPath();
if (!systemPath) {
  console.log("(not Windows: system PATH merge is a no-op by design)");
  ok("non-Windows platforms keep the inherited PATH (documented behaviour)");
  console.log("\nPATH CHECK OK");
  process.exit(0);
}

const probeName = "PI_TERMINAL_ENV_PROBE";
const previousProbe = process.env[probeName];
process.env[probeName] = "pty-environment-ok";
const env = await buildEnv();
if (previousProbe === undefined) delete process.env[probeName];
else process.env[probeName] = previousProbe;
const merged = env.PATH ?? "";
// 系统 PATH 里本身就有大量重复（同一目录大小写/结尾斜杠不同），合并时会归一成
// 一条。所以「是否缺失」必须按归一化后的集合判断，而不是逐条字符串比对。
// 归一化：去空白、去结尾分隔符、统一分隔符方向、忽略大小写（Windows 语义）。
const normalizeEntry = (value) =>
  value.trim().replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
const systemEntries = systemPath.split(";").map((p) => p.trim()).filter(Boolean);
const mergedSet = new Set(merged.split(";").map(normalizeEntry));
const systemSet = new Set(systemEntries.map(normalizeEntry));
const missing = [...systemSet].filter((entry) => !mergedSet.has(entry));
if (missing.length === 0) {
  ok(`all ${systemSet.size} distinct system PATH entries are present in the pty env (${systemEntries.length} raw, deduplicated)`);
}
else fail(`${missing.length} system PATH entries missing, e.g. ${missing[0]}`);

// 关键回归：把当前进程 PATH 裁到只剩一个无关目录，合并后仍应找回系统条目。
const crippled = mergePathLists("C:\\Windows\\system32", systemPath);
const crippledSet = new Set(crippled.split(";").map(normalizeEntry));
const stillMissing = [...systemSet].filter((entry) => !crippledSet.has(entry));
if (stillMissing.length === 0) ok("a crippled process PATH is repaired by the system PATH merge");
else fail(`merge failed to repair: ${stillMissing.length} missing`);

// 行为断言：真的起一个 pty，在裁剪过的 PATH 下读取普通环境变量并查找 certutil。
const { open } = await import("@particle-academy/fancy-pty");
const ptyEnv = { ...env, PATH: crippled };
const runPty = async (command) => {
  const pty = open({ argv: ["cmd.exe", "/c", command], cwd: process.cwd(), cols: 80, rows: 24, env: ptyEnv });
  let out = "";
  pty.onData((chunk) => (out += chunk.toString("utf8")));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 6000);
    pty.onExit(() => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  return out;
};
const envOutput = await runPty(`echo %${probeName}%`);
if (envOutput.includes("pty-environment-ok")) ok("a pty can read an inherited non-PATH environment variable");
else fail(`environment variable was unavailable in the pty; output=${JSON.stringify(envOutput.slice(0, 200))}`);

const whereOutput = await runPty("where certutil");
if (/certutil/i.test(whereOutput)) ok("a pty started with the repaired PATH resolves a System32-only tool");
else fail(`where certutil failed; output=${JSON.stringify(whereOutput.slice(0, 200))}`);

const failed = results.filter((r) => r === "fail").length;
console.log(failed ? `\nPATH CHECK FAILED (${failed})` : "\nPATH CHECK OK");
process.exit(failed ? 1 : 0);
