/**
 * 复现「交互式 shell 读不到环境变量」。
 *
 * 上一个探针用 `-Command` 一次性执行，env 是好的；用户报的是**交互式**使用
 * （打开终端后敲命令）。差别在于 PowerShell 交互式启动会加载 profile，而
 * `-NoProfile` 与否会改变它看到的环境。
 *
 * 这里起真正的交互式 shell，然后往 pty 里写查询命令，看它回显什么。
 */
import { open } from "@particle-academy/fancy-pty";
import { buildEnv } from "../dist-env-test.mjs";

process.env.PI_TERMINAL_PROBE = "probe-value-42";
const env = await buildEnv();

function interactive(argv, label, commands, settleMs = 7000) {
  return new Promise((resolve) => {
    const pty = open({ argv, cwd: process.cwd(), cols: 200, rows: 40, env });
    let out = "";
    pty.onData((chunk) => {
      out += chunk.toString("utf8");
    });
    pty.onExit(() => resolve({ label, out }));
    let index = 0;
    const send = () => {
      if (index >= commands.length) {
        setTimeout(() => {
          try {
            pty.kill();
          } catch {
            /* 已退出 */
          }
          resolve({ label, out });
        }, 800);
        return;
      }
      pty.write(`${commands[index]}\r`);
      index += 1;
      setTimeout(send, 900);
    };
    setTimeout(send, 700);
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
  [["cmd.exe"], "cmd (interactive)", ["echo PROBE=%PI_TERMINAL_PROBE%", "echo PATHLEN=%PATH:~0,0%%PATH%"]],
  [
    ["powershell.exe", "-NoLogo"],
    "powershell (interactive, as the plugin starts it)",
    ["Write-Output \"PROBE=$env:PI_TERMINAL_PROBE\"", "Write-Output \"PATHLEN=$($env:PATH.Length)\""],
  ],
  [
    ["powershell.exe", "-NoLogo", "-NoProfile"],
    "powershell (interactive + -NoProfile)",
    ["Write-Output \"PROBE=$env:PI_TERMINAL_PROBE\"", "Write-Output \"PATHLEN=$($env:PATH.Length)\""],
  ],
];

for (const [argv, label, commands] of cases) {
  const result = await interactive(argv, label, commands);
  const text = strip(result.out);
  console.log(`--- ${label} ---`);
  console.log(text.split("\n").filter((line) => /PROBE=|PATHLEN=/.test(line)).join("\n") || text.slice(0, 300));
}
