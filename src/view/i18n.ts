/**
 * 视图侧多语言。
 *
 * ── 与 PI-Desktop 保持一致的做法 ──────────────────────────────────────────
 * 宿主向插件提供 `app.getLocale`（返回应用当前语言，如 `zh-CN` / `en`），
 * 并在清单里用 `i18n` 描述插件名/描述。**视图自身的文案宿主不会替我们翻译**，
 * 所以这里自己带一份词表，用宿主的语言值选表。
 *
 * 三个刻意的取舍：
 *   1. 词表用「键 → 该语言文本」的扁平结构，缺键时**回退英文而不是显示键名**：
 *      终端是工作工具，露出一句英文比露出 `profile.editHost` 有用。
 *   2. 语言解析按 BCP-47 前缀匹配：`zh-TW` / `zh-Hans` 都落到 `zh-CN`
 *      （词表只有简体，简繁混排比半句英文更糟）。
 *   3. 语言切换后需要重绘界面：`applyLocale` 会触发一次 `onLocaleChanged`
 *      回调，由 main.ts 重新渲染可见部分（终端内容不重绘，它是字节流）。
 */

export type Locale = "en" | "zh-CN";

export const SUPPORTED_LOCALES: Locale[] = ["en", "zh-CN"];

const EN = {
  "app.newLocal": "New local",
  "app.newLocalHint": "Start a local terminal",
  "app.newSsh": "New SSH",
  "app.newSshHint": "Connect to a saved host",
  "app.hosts": "Hosts",
  "app.hostsHint": "Manage saved SSH connections, grouped",
  "app.settings": "Settings",
  "app.settingsHint": "Terminal settings",

  "hosts.add": "Add host",
  "hosts.addHint": "Create a saved SSH connection",
  "hosts.count": "{count} host(s)",

  "empty.title": "No terminal sessions yet.",
  "empty.body": "Start a local shell, or connect to a host you have saved.",
  "empty.blocked": "The last attempt failed: {message}",
  "empty.blockedHint":
    "If this mentions a missing pty helper, the plugin was installed without its node_modules folder — reinstall it from the .piplug package.",
  "empty.hint":
    "Ctrl+Shift+T starts a local terminal. Every session is a real pty, so interactive programs (vim, top, ssh, python) behave exactly as they do in a native terminal.",

  "status.nothingSelected": "Nothing selected",
  "status.copied": "Copied {count} characters",
  "status.copyFailed": "Could not copy: the clipboard is not available in this view",
  "status.clipboardUnavailable": "Could not read the clipboard in this view",
  "status.clipboardEmpty": "The clipboard is empty",
  "status.pasted": "Pasted {count} characters",
  "status.pasteFailed": "Paste failed: {message}",
  "status.pasteConfirm": "Paste {count} lines into the terminal?",
  "status.inputFailed": "Input failed: {message}",
  "status.connecting": "Connecting…",
  "status.streaming": "streaming",
  "status.polling": "polling (the loopback port is unavailable)",
  "status.sessionLine": "{kind} · {title} · {state}",
  "status.limitReached": "You have reached the live-session limit ({limit}). Close a terminal first.",
  "status.openingLocal": "Starting a local terminal…",
  "status.openLocalFailed": "Could not start a local terminal: {message}",
  "status.openSshFailed": "Could not connect: {message}",
  "status.hostKeyDeclined": "The host key was not confirmed, so the connection was refused. Try again and press \"Trust and connect\".",
  "status.closeFailed": "Could not close the session: {message}",
  "status.renameFailed": "Could not rename: {message}",
  "status.settingsSaved": "Settings saved",
  "status.settingsFailed": "Could not save settings: {message}",
  "status.settingsUnavailable": "Settings are unavailable.",
  "status.hostSaved": "Host added",
  "status.hostUpdated": "Host updated",
  "status.hostSaveFailed": "Could not save the host: {message}",
  "status.hostDeleted": "Host deleted",
  "status.hostDeleteFailed": "Could not delete: {message}",
  "status.hostsLoadFailed": "Could not load hosts: {message}",
  "status.sessionsSyncFailed": "Could not synchronize terminal sessions: {message}",
  "status.sessionAvailable": "New terminal session available: {title}",
  "status.testOk": "Connected to {host}:{port} in {ms} ms",
  "status.testStarting": "Testing connection…",
  "status.testFailed": "Connection test failed: {message}",
  "status.revealFailed": "Could not reveal the password: {message}",
  "status.renamePrompt": "Rename this terminal",
  "status.deleteConfirm": 'Delete the saved host "{name}"?',
  "status.closeLabel": "Close {title}",
  "status.unknownCwd": "unknown cwd",

  "profiles.title": "SSH hosts",
  "profiles.note":
    "Group hosts to keep them apart (leave Group empty for Ungrouped). Private keys and ssh-agent are preferred; a saved password is encrypted with the OS keystore and only shown when you press the eye button.",
  "profiles.empty": "No saved hosts yet.",
  "profiles.newHost": "New host",
  "profiles.editHost": "Edit host",
  "profiles.groupUngrouped": "Ungrouped",
  "profiles.groupOther": "Other",
  "profiles.groupCount": "{count} host(s)",
  "profiles.connect": "Connect",
  "profiles.connectHint": "Connect to {name}",
  "profiles.edit": "Edit",
  "profiles.editHint": "Edit {name}",
  "profiles.test": "Test",
  "profiles.testHint": "Test the connection to {name}",
  "profiles.delete": "Delete",
  "profiles.deleteHint": "Delete {name}",
  "profiles.savedPassword": "password saved",
  "profiles.savedPassphrase": "passphrase saved",

  "form.addTitle": "Add a host",
  "form.editTitle": "Edit {name}",
  "form.name": "Name",
  "form.namePlaceholder": "prod web",
  "form.host": "Host",
  "form.hostPlaceholder": "example.com",
  "form.port": "Port",
  "form.user": "User",
  "form.userPlaceholder": "deploy",
  "form.auth": "Authentication",
  "form.authAgent": "ssh-agent",
  "form.authKey": "private key",
  "form.authPassword": "password",
  "form.group": "Group",
  "form.groupPlaceholder": "empty = Ungrouped",
  "form.privateKeyPath": "Private key path",
  "form.privateKeyPlaceholder": "~/.ssh/id_ed25519",
  "form.passphrase": "Key passphrase",
  "form.passphraseSaved": "saved — leave empty to keep",
  "form.passphraseHint": "only if the key has one",
  "form.password": "Password",
  "form.passwordSaved": "saved — leave empty to keep",
  "form.passwordHint": "not stored until you save",
  "form.showSecret": "Show the password",
  "form.hideSecret": "Hide the password",
  "form.clearPassword": "forget the saved password",
  "form.clearPassphrase": "forget the saved passphrase",
  "form.initialCommand": "Initial command",
  "form.optional": "optional",
  "form.save": "Save changes",
  "form.create": "Add host",
  "form.cancel": "Cancel",

  "settings.title": "Settings",
  "settings.secretStore": "Credential storage: {detail}",
  "settings.defaultShell": "Default shell",
  "settings.cwdMode": "New session starts in",
  "settings.cwdWorkspace": "project root",
  "settings.cwdHome": "home directory",
  "settings.scrollback": "Scrollback lines",
  "settings.fontSize": "Font size",
  "settings.fontFamily": "Font family",
  "settings.cursorBlink": "blinking cursor",
  "settings.confirmPaste": "ask before pasting multiple lines",
  "settings.relay": "stream output over the loopback port (faster; falls back to polling)",
  "settings.maxSessions": "Max live sessions",
  "settings.keepalive": "SSH keepalive (seconds)",
  "settings.save": "Save settings",

  "hostkey.title": "Verify the host key for {host}",
  "hostkey.titleGeneric": "Verify this host's key",
  "hostkey.body":
    "Fingerprint: {fingerprint}. Compare it with what the server administrator gave you. Nothing has been sent to this host yet.",
  "hostkey.none": "No host key is waiting for confirmation.",
  "hostkey.trust": "Trust and connect",
  "hostkey.trustHint": "Remember this fingerprint and continue",
  "hostkey.cancel": "Cancel",
  "hostkey.cancelHint": "Do not connect",

  "settings.bufferBytes": "Per-session output buffer (bytes)",
  "settings.fontDefault": "Default (monospace first)",
  "settings.fontLoading": "Detecting the installed monospace fonts…",
  "settings.fontsCount": "{count} monospace family(ies) available",
  "status.fontsFailed": "Could not list the installed fonts: {message}",
  "settings.sectionStartup": "Startup",
  "settings.sectionAppearance": "Appearance",
  "settings.sectionSessions": "Sessions",
  "settings.sectionInteraction": "Interaction",
  "settings.sectionNetwork": "Network",
  "settings.defaultShellPlaceholder": "command name or absolute path",
  "settings.bufferMiB": "Output buffer (MiB)",
  "settings.bufferHint": "per session, kept in memory",

  "settings.reset": "Reset to default",
  "tab.menu": "Tab actions",
  "tab.copyId": "Copy session id",
  "tab.rename": "Rename tab",
  "status.copiedId": "Session id copied: {id}",
  "common.close": "Close",
  "common.closeHint": "Close this panel",
  "common.local": "local",
  "common.ssh": "ssh",
} as const;

export type MessageKey = keyof typeof EN;

const ZH: Record<MessageKey, string> = {
  "app.newLocal": "新建本地",
  "app.newLocalHint": "打开一个本地终端",
  "app.newSsh": "新建 SSH",
  "app.newSshHint": "连接到一个已保存的主机",
  "app.hosts": "主机",
  "app.hostsHint": "按分组管理已保存的 SSH 连接",
  "app.settings": "设置",
  "app.settingsHint": "终端设置",

  "hosts.add": "添加主机",
  "hosts.addHint": "新建一条已保存的 SSH 连接",
  "hosts.count": "{count} 台主机",

  "empty.title": "还没有终端会话。",
  "empty.body": "开一个本地 shell，或连接已保存的主机。",
  "empty.blocked": "上一次尝试失败：{message}",
  "empty.blockedHint":
    "如果提示缺少 pty helper，说明插件安装时漏掉了 node_modules 目录——请用 .piplug 包重新安装。",
  "empty.hint":
    "Ctrl+Shift+T 打开本地终端。每个会话都是真实 pty，因此 vim、top、ssh、python 等交互式程序的表现与原生终端一致。",

  "status.nothingSelected": "没有选中内容",
  "status.copied": "已复制 {count} 个字符",
  "status.copyFailed": "复制失败：此视图无法访问剪贴板",
  "status.clipboardUnavailable": "此视图无法读取剪贴板",
  "status.clipboardEmpty": "剪贴板是空的",
  "status.pasted": "已粘贴 {count} 个字符",
  "status.pasteFailed": "粘贴失败：{message}",
  "status.pasteConfirm": "要粘贴 {count} 行到终端吗？",
  "status.inputFailed": "输入失败：{message}",
  "status.connecting": "连接中…",
  "status.streaming": "实时流",
  "status.polling": "轮询中（回环端口不可用）",
  "status.sessionLine": "{kind} · {title} · {state}",
  "status.limitReached": "已达到活动会话上限（{limit}）。请先关闭一个终端。",
  "status.openingLocal": "正在启动本地终端…",
  "status.openLocalFailed": "无法启动本地终端：{message}",
  "status.openSshFailed": "无法连接：{message}",
  "status.closeFailed": "无法关闭会话：{message}",
  "status.hostKeyDeclined": "主机指纹未确认，连接已拒绝。请重试并在弹窗里点「信任并连接」。",
  "status.renameFailed": "无法重命名：{message}",
  "status.settingsSaved": "设置已保存",
  "status.settingsFailed": "无法保存设置：{message}",
  "status.settingsUnavailable": "设置当前不可用。",
  "status.hostSaved": "主机已添加",
  "status.hostUpdated": "主机已更新",
  "status.hostSaveFailed": "无法保存主机：{message}",
  "status.hostDeleted": "主机已删除",
  "status.hostDeleteFailed": "无法删除：{message}",
  "status.hostsLoadFailed": "无法加载主机列表：{message}",
  "status.sessionsSyncFailed": "无法同步终端会话：{message}",
  "status.sessionAvailable": "有新的终端会话：{title}",
  "status.testOk": "已连接 {host}:{port}，耗时 {ms} 毫秒",
  "status.testStarting": "正在测试连接…",
  "status.testFailed": "连接测试失败：{message}",
  "status.revealFailed": "无法显示密码：{message}",
  "status.renamePrompt": "重命名这个终端",
  "status.deleteConfirm": "删除已保存的主机「{name}」？",
  "status.closeLabel": "关闭 {title}",
  "status.unknownCwd": "目录未知",

  "profiles.title": "SSH 主机",
  "profiles.note":
    "用分组把主机区分开（分组留空即「未分组」）。优先使用私钥与 ssh-agent；保存的密码由操作系统密钥库加密，只有点小眼睛时才显示。",
  "profiles.empty": "还没有保存的主机。",
  "profiles.newHost": "新建主机",
  "profiles.editHost": "编辑主机",
  "profiles.groupUngrouped": "未分组",
  "profiles.groupOther": "其他",
  "profiles.groupCount": "{count} 台",
  "profiles.connect": "连接",
  "profiles.connectHint": "连接到 {name}",
  "profiles.edit": "编辑",
  "profiles.editHint": "编辑 {name}",
  "profiles.test": "测试",
  "profiles.testHint": "测试到 {name} 的连接",
  "profiles.delete": "删除",
  "profiles.deleteHint": "删除 {name}",
  "profiles.savedPassword": "已保存密码",
  "profiles.savedPassphrase": "已保存口令",

  "form.addTitle": "新增主机",
  "form.editTitle": "编辑 {name}",
  "form.name": "名称",
  "form.namePlaceholder": "生产 Web",
  "form.host": "主机",
  "form.hostPlaceholder": "example.com",
  "form.port": "端口",
  "form.user": "用户",
  "form.userPlaceholder": "deploy",
  "form.auth": "认证方式",
  "form.authAgent": "ssh-agent",
  "form.authKey": "私钥",
  "form.authPassword": "密码",
  "form.group": "分组",
  "form.groupPlaceholder": "留空 = 未分组",
  "form.privateKeyPath": "私钥路径",
  "form.privateKeyPlaceholder": "~/.ssh/id_ed25519",
  "form.passphrase": "私钥口令",
  "form.passphraseSaved": "已保存，留空则保持不变",
  "form.passphraseHint": "私钥有口令时才需要填",
  "form.password": "密码",
  "form.passwordSaved": "已保存，留空则保持不变",
  "form.passwordHint": "保存后才会存储",
  "form.showSecret": "显示密码",
  "form.hideSecret": "隐藏密码",
  "form.clearPassword": "忘记已保存的密码",
  "form.clearPassphrase": "忘记已保存的口令",
  "form.initialCommand": "登录后执行",
  "form.optional": "可选",
  "form.save": "保存修改",
  "form.create": "添加主机",
  "form.cancel": "取消",

  "settings.title": "设置",
  "settings.secretStore": "凭据存储：{detail}",
  "settings.defaultShell": "默认 Shell",
  "settings.cwdMode": "新会话起始目录",
  "settings.cwdWorkspace": "项目根目录",
  "settings.cwdHome": "用户主目录",
  "settings.scrollback": "回滚行数",
  "settings.fontSize": "字号",
  "settings.fontFamily": "字体",
  "settings.cursorBlink": "光标闪烁",
  "settings.confirmPaste": "多行粘贴前询问",
  "settings.relay": "通过本机回环端口推送输出（更快；不可用时自动降级为轮询）",
  "settings.maxSessions": "活动会话上限",
  "settings.keepalive": "SSH keepalive 间隔（秒）",
  "settings.save": "保存设置",

  "hostkey.title": "确认 {host} 的主机指纹",
  "hostkey.titleGeneric": "确认此主机指纹",
  "hostkey.body": "指纹：{fingerprint}。请与服务器管理员给的值核对。此时尚未向该主机发送任何凭据。",
  "hostkey.none": "没有等待确认的主机指纹。",
  "hostkey.trust": "信任并连接",
  "hostkey.trustHint": "记住该指纹并继续",
  "hostkey.cancel": "取消",
  "hostkey.cancelHint": "不连接",

  "common.close": "关闭",
  "common.closeHint": "关闭此面板",
  "common.local": "本地",
  "settings.bufferBytes": "每会话输出缓冲（字节）",
  "settings.fontDefault": "默认（等宽字体优先）",
  "settings.fontLoading": "正在检测已安装的等宽字体…",
  "settings.fontsCount": "可用等宽字体 {count} 个",
  "status.fontsFailed": "无法列出已安装字体：{message}",
  "settings.sectionStartup": "启动",
  "settings.sectionAppearance": "外观",
  "settings.sectionSessions": "会话",
  "settings.sectionInteraction": "交互",
  "settings.sectionNetwork": "网络",
  "settings.defaultShellPlaceholder": "命令名或绝对路径",
  "settings.bufferMiB": "输出缓冲（MiB）",
  "settings.bufferHint": "每个会话，保存在内存里",

  "settings.reset": "重置为默认值",
  "tab.menu": "选项卡操作",
  "tab.copyId": "复制会话 ID",
  "tab.rename": "重命名选项卡",
  "status.copiedId": "已复制会话 ID：{id}",
  "common.ssh": "SSH",
};

const TABLES: Record<Locale, Record<MessageKey, string>> = {
  en: EN as unknown as Record<MessageKey, string>,
  "zh-CN": ZH,
};

let activeLocale: Locale = "en";

/**
 * 把宿主的语言值解析成本插件支持的 locale。
 *
 * `zh-TW` / `zh-HK` / `zh-Hans` 一律归到 `zh-CN`：本插件只带一份中文词表，
 * 混着显示繁简比统一显示简体更难读。其余语言回退英文。
 */
export function resolveLocale(raw: string | null | undefined): Locale {
  const value = (raw ?? "").trim();
  if (!value) return "en";
  const lower = value.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return "en";
}

export function getLocale(): Locale {
  return activeLocale;
}

/**
 * 切换语言。返回是否真的变了 —— 只有变了才需要重绘，
 * 否则每次 appearance 事件都会白重画一次界面。
 */
export function setLocale(locale: Locale): boolean {
  if (locale === activeLocale) return false;
  activeLocale = locale;
  // 宿主页面与单测环境都可能没有 document；语言状态本身不依赖 DOM，
  // 因此这里只是「顺手同步 <html lang>」，同步失败不该让切换失败。
  try {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  } catch {
    /* 非 DOM 环境 */
  }
  return true;
}

/**
 * 取一条文案并填充占位符 `{name}`。
 *
 * 占位符用简单替换而不是模板引擎：词表是静态的，不需要表达式求值；而让用户
 * 数据（主机名、错误信息）走模板求值是一条不必要的注入面。
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const table = TABLES[activeLocale] ?? TABLES.en;
  const template = table[key] ?? TABLES.en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** 供测试：把某个 locale 的词表拿来对照（验证键集合一致）。 */
export function messagesFor(locale: Locale): Record<string, string> {
  return { ...TABLES[locale] };
}
