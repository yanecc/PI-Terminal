import { buildEnv } from "../dist-env-test.mjs";

const env = await buildEnv();
const entries = (env.PSModulePath ?? "").split(";").filter(Boolean);
console.log(`PSModulePath has ${entries.length} entries:`);
for (const entry of entries) console.log(`  ${entry}`);

const lower = entries.map((entry) => entry.toLowerCase());
const needs = [
  String.raw`c:\program files\windowspowershell\modules`,
  String.raw`c:\windows\system32\windowspowershell\v1.0\modules`,
];
for (const want of needs) {
  const present = lower.some((entry) => entry.replace(/[\\/]+$/, "") === want);
  console.log(`${present ? "OK  " : "MISS"} ${want}`);
}

// 交互式 powershell 是否真的能用模块系统（profile 加载的前提）。
const { open } = await import("@particle-academy/fancy-pty");
const pty = open({ argv: ["powershell.exe", "-NoLogo"], cwd: process.cwd(), cols: 200, rows: 40, env });
let out = "";
pty.onData((chunk) => {
  out += chunk.toString("utf8");
});
pty.write("Write-Output ('MODULES=' + ($env:PSModulePath.Split(';').Count))\r");
await new Promise((resolve) => setTimeout(resolve, 2500));
try {
  pty.kill();
} catch {
  /* 已退出 */
}
const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const hit = clean.split("\n").find((line) => line.includes("MODULES="));
console.log(`interactive powershell reports: ${hit?.trim() ?? "(no output)"}`);
