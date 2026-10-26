/**
 * 清单单一真源。
 *
 * 为什么不用手写 manifest.json：
 *   - 工具清单必须与 `pi.agent.registerTool` 的实际注册一一对应，手写一定会漂移；
 *   - i18n（en / zh-CN）两边的占位符与条目必须完全对齐；
 *   - 权限与 `docs/SECURITY.md` 的说明要能对上，改一处就该同时改另一处。
 * 因此清单在这里生成，`build.mjs` 调用本文件产出根目录的 manifest.json。
 */
import { TOOL_DECLARATIONS } from "./host/tools/declarations.js";

type Localized = string | { en: string; "zh-CN": string };

interface ViewDecl {
  id: string;
  title: Localized;
  icon: string;
  entry: string;
  order: number;
}

/**
 * 插件名。扩展/命令里用它标识「这是哪个插件」。
 *
 * 注意：**面板标签不用它**（见 `viewTitle`）—— 面板标签描述的是「这里是
 * 什么」，不是「这是谁提供的」。写成 `PI-Terminal` 会让右侧面板的新建按钮
 * 下方显示一个既不是功能、也不是当前内容的词。
 */
const name = "PI-Terminal";
const nameZh = "PI-Terminal";

/**
 * 右侧工作面板的标签文案。
 *
 * 这是用户一眼看到的那一行，必须说明**面板里是什么**：「终端」。插件身份
 * 由扩展列表和命令前缀承担，重复一次只会挤掉有用信息。
 * 两种语言都用各自的自然写法（中文「终端」、英文 `Terminal`）。
 */
const viewTitle = "Terminal";
const viewTitleZh = "终端";

const description =
  "A terminal in the right work panel: local shells and SSH sessions with a real pty, tabs, session persistence, and agent read/write over the terminal. Inspectable but never silently destructive.";
const descriptionZh =
  "右侧工作面板里的终端：本地 shell 与 SSH 远程会话（真实 pty）、多标签、会话持久化，并允许模型读取与写入终端内容。可审阅，但绝不静默执行破坏性操作。";

const safetyNotes =
  "Runs commands locally through a real pty (fancy-pty helper) and remotely over SSH (ssh2) inside the plugin's own process. Terminal output never leaves the machine except over the SSH connection the user configured. Credentials: private keys and ssh-agent are preferred and never copied; when a password is stored it is encrypted at rest with the OS keystore (DPAPI / Keychain / libsecret) under the plugin data directory, shown in clear only on an explicit reveal action that is audited. Host keys are verified and stored in OpenSSH known_hosts format; a changed fingerprint refuses the connection. File transfers (upload/download) run over the same already-authenticated SSH connection using ssh2-sftp-client: no second handshake and no second credential use. Agent tools are split by risk: reading is low risk, writing to a terminal and moving files are high risk and ask the user before they run. No telemetry and no third-party server. The UI follows the application language (English and Simplified Chinese); local terminals inherit the system PATH, including entries added after the host application started.";
const safetyNotesZh =
  "在插件自己的进程内通过真实 pty（fancy-pty helper）执行本地命令，并通过 SSH（ssh2）执行远程命令。终端内容除走用户自己配置的 SSH 连接外不会离开本机。凭据：优先使用私钥与 ssh-agent 且从不复制；若保存密码，则用操作系统密钥库（DPAPI / Keychain / libsecret）加密后存放在插件数据目录，只有在用户显式点开小眼睛时才返回明文，且该动作写入审计。主机指纹按 OpenSSH known_hosts 格式校验并保存，指纹变化时拒绝连接。文件上传与下载复用同一条已认证的 SSH 连接，由 ssh2-sftp-client 完成，不会再握手一次、也不会二次使用凭据。模型工具按风险分级：读取为低风险，写入终端与搬运文件为高风险并在执行前询问。无遥测、无第三方服务器。界面跟随应用语言（英文与简体中文）；本地终端继承系统 PATH，包括宿主机启动后新加入的条目。";

/*
 * 这里**没有** `contributes.settings`：插件设置只从终端面板的「设置」进入。
 *
 * 原因是宿主设置页的下拉选项只能来自 manifest 的静态声明（`enum`），而
 * 「终端字体」必须列出这台机器上真实安装且实测等宽的字体 —— 那是运行期才
 * 知道的事实。为了不让同一个值出现两个入口（并各自漂移），设置整体搬进了
 * 面板；键与默认值的唯一真源是 `src/host/settings.ts` 的 `DEFAULT_SETTINGS`。
 */

const manifest = {
  schemaVersion: 1,
  // 反向域名形式：cc.fee 是发布者命名空间，pi-terminal 是插件名。
  id: "cc.fee.pi-terminal",
  name,
  version: "1.0.0",
  description,
  author: "Sunrise",
  license: "Apache-2.0",
  categories: ["productivity", "developer-tools"],
  main: "main.js",
  engines: { piDesktop: ">=0.20.0" },
  activationEvents: ["onStartup"],
  permissions: [
    "ui.view",
    "net.fetch",
    "agent.tool.register",
    "clipboard.read",
    "clipboard.write",
    "notify",
  ],
  // 输出流走本机回环端口；这里必须与 relay/server.ts 实际监听的主机一致。
  net: { domains: ["127.0.0.1"] },
  contributes: {
    views: [
      {
        id: "terminal",
        title: { en: viewTitle, "zh-CN": viewTitleZh },
        icon: "terminal",
        entry: "views/index.html",
        order: 20,
      } satisfies ViewDecl,
    ],
    // 只保留两个「跨会话的批量动作」。新建终端、打开面板都在视图里，命令面板
    // 再放一份只会让用户在两个入口之间猜（见 host/index.ts 的说明）。
    commands: [
      { id: "pi-terminal.closeAll", title: "PI-Terminal: Close All Sessions", category: "PI-Terminal", keywords: ["close", "all", "关闭", "全部"] },
      { id: "pi-terminal.resetSettings", title: "PI-Terminal: Reset All Settings", category: "PI-Terminal", keywords: ["reset", "settings", "重置", "设置"] },
    ],
    agentTools: TOOL_DECLARATIONS,
  },
  i18n: {
    en: { name, description, safetyNotes },
    "zh-CN": { name: nameZh, description: descriptionZh, safetyNotes: safetyNotesZh },
  },
};

export { manifest };
