/**
 * 复现「只有 cmd 能读到环境变量」。
 *
 * 用同一份 env 分别起 cmd 与 powershell，让它们各自打印 PATH 长度和一个
 * 自定义变量，再与父进程里的期望值比较。差别会立刻暴露是「env 没传进去」
 * 还是「shell 启动方式把 env 清掉了」。
 */
import { open } from "@particle-academy/fancy-pty";
import { buildEnv } from "../dist-env-test.mjs";

process.env.PI_TERMINAL_PROBE = "probe-value-42";

const env = await buildEnv();
const expectedPath = (env.PATH ?? "").length;

function run(argv, label, settleMs = 6000) {
  return new Promise((resolve) => {
    const pty = open({ argv, cwd: process.cwd(), cols: 200, rows: 40, env });
    let out = "";
    pty.onData((chunk) => {
      out += chunk.toString("utf8");
    });
    pty.onExit(() => resolve({ label, out }));
    setTimeout(() => {
      try {
        pty.kill();
      } catch {
        /* 已退出 */
      }
      resolve({ label, out: `${out}\n[TIMEOUT]` });
    }, settleMs);
  });
}

const strip = (value) => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").trim();

const cases = [
  [["cmd.exe", "/d", "/s", "/c", "echo PATHLEN=%PATHTMPLEN% & echo PROBE=%PI_TERMINAL_PROBE%"], "cmd"],
  [
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Write-Output ('PATHLEN=' + $env:PATH.Length); Write-Output ('PROBE=' + $env:PI_TERMINAL_PROBE)"],
    "powershell",
  ],
  [
    ["pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "Write-Output ('PATHLEN=' + $env:PATH.Length); Write-Output ('PROBE=' + $env:PI_TERMINAL_PROBE)"],
    "pwsh",
  ],
];

console.log(`expected PATH length from buildEnv(): ${expectedPath}`);
for (const [argv, label] of cases) {
  const result = await run(argv, label);
  const text = strip(result.out);
  if (!text) {
    console.log(`--- ${label}: (no output; shell probably not installed) ---`);
    continue;
  }
  console.log(`--- ${label} ---`);
  console.log(text.slice(0, 500));
}
