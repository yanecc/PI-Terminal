/**
 * 安装完整性检查：**已安装目录**里必须有的东西是否都在。
 *
 * 为什么单独有这一步：`package-check` 只看 .piplug，而真正跑起来的是安装目录。
 * 「新建本地终端 → Tab 划线 / unknown cwd / 空白」的根因正是安装目录里没有
 * node_modules（也就没有 pty helper）：SSH 不依赖 helper 所以照常能用，本地
 * 终端却在 describe() 之前就失败了。
 *
 * 用法：node scripts/install-check.mjs [安装目录]
 *   默认 C:/Users/Sunrise/.pi-desktop/plugins/installed/cc.fee.pi-terminal
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir =
  process.argv[2] ?? "C:/Users/Sunrise/.pi-desktop/plugins/installed/cc.fee.pi-terminal";

const helperName = process.platform === "win32" ? "fancy-pty-helper.exe" : "fancy-pty-helper";
const platform = `${process.platform}-${process.arch}`;

const required = [
  "main.js",
  "core.pi",
  "manifest.json",
  "package.json",
  "views/index.html",
  "views/assets/view.js",
  "views/assets/view.css",
  "views/assets/xterm.css",
  // 安装后的形态里**没有 node_modules**：PI-Desktop 的安装器会跳过这个目录名。
  // 所以 helper 必须在顶层 bin/，这里是唯一会被解出来的位置。
  `bin/${platform}/${helperName}`,
  "vendor/font-list/index.js",
];

let failed = 0;
const ok = (message) => console.log(`✔ ${message}`);
const bad = (message) => {
  console.error(`✖ ${message}`);
  failed += 1;
};

if (!existsSync(dir)) {
  // 「还没装」不是打包缺陷：插件 id 从 local.pi-terminal 改成 cc.fee.pi-terminal 之后，
  // 新目录要等用户装一次才会出现。显式传了目录却不存在才算失败。
  if (process.argv[2]) {
    bad(`the install directory does not exist: ${dir}`);
  } else {
    console.warn(`[install-check] not installed yet (${dir}); install the .piplug and run this again to verify the installed copy`);
  }
} else {
  for (const rel of required) {
    const path = join(dir, rel);
    if (!existsSync(path)) {
      // vendor/ 是「新版安装」才有的东西：老安装目录里没有它，说明这份安装
      // 早于当前构建，提醒重装即可，不要把它当成包损坏。
      if (rel.startsWith("vendor/")) {
        console.warn(`[install-check] ${rel} is missing: this install predates the current build; reinstall the .piplug`);
        continue;
      }
      bad(`missing: ${rel}`);
      continue;
    }
    if (rel.includes("fancy-pty-helper")) {
      // 可执行位是必须的：丢了权限位在 Linux/macOS 上会 EACCES。
      const mode = statSync(path).mode;
      if (process.platform !== "win32" && (mode & 0o111) === 0) {
        bad(`${rel} is not executable (mode ${(mode & 0o777).toString(8)})`);
        continue;
      }
      if (statSync(path).size === 0) {
        bad(`${rel} is empty`);
        continue;
      }
    }
    ok(`present: ${rel}`);
  }

  // manifest 的 main 字段必须真的存在。
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const main = typeof manifest.main === "string" ? manifest.main.replace(/^\.\//, "") : "";
    if (main && !existsSync(join(dir, main))) bad(`manifest.main points at a missing file: ${main}`);
    else if (main) ok(`manifest.main resolves: ${main}`);
  } catch (error) {
    bad(`manifest.json is not readable JSON: ${String(error?.message ?? error)}`);
  }
}

console.log(failed ? `\nINSTALL CHECK FAILED (${failed})` : "\nINSTALL CHECK OK");
process.exit(failed ? 1 : 0);
