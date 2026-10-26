/**
 * SSH 主机管理面板（分组 + 折叠 + 表单）。
 *
 * ── 为什么要重做（0.1.1 的结构性问题）─────────────────────────────────────
 * 上一版把「+ SSH」和「Hosts」做成同一个入口（都直接打开档案面板），于是
 * 「连接」和「管理」两件事混在一个列表里：想连一台机器要在一堆管理按钮
 * （Edit/Test/Delete）中间找 Connect。
 *
 * 现在职责分开：
 *   + SSH  → 连接选择器：只列主机，点一下就连，没有管理动作。
 *   Hosts  → 管理面板：按分组折叠展示、增删改、测试连接。
 *
 * 分组用自由文本（`profile.group`），空值归到「未分组」。折叠状态记在内存里
 * 而不是落盘：它是「刚才看的那一组」这种瞬时上下文，跨会话保留反而奇怪。
 */

import type { SshProfile } from "../protocol.js";
import { t } from "./i18n.js";

/** 折叠状态：key 是分组名（"" = 未分组）。只活在本次面板打开期间。 */
const collapsedGroups = new Set<string>();

/** 按分组归类，并给出稳定顺序：有名字的按字母，未分组永远排最后。 */
export function groupProfiles(profiles: SshProfile[]): Array<{ group: string; items: SshProfile[] }> {
  const buckets = new Map<string, SshProfile[]>();
  for (const profile of profiles) {
    const key = (profile.group ?? "").trim();
    const list = buckets.get(key) ?? [];
    list.push(profile);
    buckets.set(key, list);
  }
  const named = [...buckets.keys()].filter((key) => key).sort((a, b) => a.localeCompare(b));
  const ordered = named.map((group) => ({
    group,
    items: (buckets.get(group) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const ungrouped = buckets.get("");
  if (ungrouped?.length) {
    ordered.push({ group: "", items: ungrouped.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return ordered;
}

export interface ProfilePanelHandlers {
  onConnect: (profileId: string) => void;
  onEdit: (profile: SshProfile) => void;
  onDelete: (profileId: string) => void;
  onTest: (profileId: string) => void;
  status: (message: string, level: "info" | "error") => void;
}

/**
 * 连接选择器：只给「点一下就连」，没有任何管理动作。
 * 没有主机的时给一句明确的「先去 Hosts 添加」，而不是一个空列表。
 */
export function renderSshPicker(root: HTMLElement, profiles: SshProfile[], onConnect: (id: string) => void): void {
  root.innerHTML = "";
  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "term-hint";
    empty.textContent = t("profiles.empty");
    root.append(empty);
    return;
  }
  for (const bucket of groupProfiles(profiles)) {
    const section = document.createElement("section");
    section.className = "term-picker-group";
    const label = document.createElement("h3");
    label.textContent = bucket.group || t("profiles.groupUngrouped");
    section.append(label);
    const list = document.createElement("div");
    list.className = "term-picker-list";
    for (const profile of bucket.items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "term-picker-item";
      item.title = t("profiles.connectHint", { name: profile.name });
      const name = document.createElement("strong");
      name.textContent = profile.name;
      const meta = document.createElement("span");
      meta.textContent = `${profile.user}@${profile.host}:${profile.port} · ${profile.auth}`;
      item.append(name, meta);
      item.addEventListener("click", () => onConnect(profile.id));
      list.append(item);
    }
    section.append(list);
    root.append(section);
  }
}

/** 管理面板：分组折叠 + 每行的管理动作。 */
export function renderProfileManager(
  root: HTMLElement,
  profiles: SshProfile[],
  handlers: ProfilePanelHandlers,
  formHolder: HTMLElement,
): void {
  root.innerHTML = "";
  if (profiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "term-hint";
    empty.textContent = t("profiles.empty");
    root.append(empty);
  }

  for (const bucket of groupProfiles(profiles)) {
    const key = bucket.group;
    // 默认展开；用户点过折叠才记住。未分组也同样可折叠，行为一致。
    const collapsed = collapsedGroups.has(key);

    const section = document.createElement("section");
    section.className = "term-group";
    section.dataset.group = key || "_ungrouped";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "term-group-head";
    header.dataset.collapsed = String(collapsed);
    header.setAttribute("aria-expanded", String(!collapsed));
    const caret = document.createElement("span");
    caret.className = "term-group-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▸";
    const title = document.createElement("span");
    title.className = "term-group-title";
    title.textContent = key || t("profiles.groupUngrouped");
    const count = document.createElement("span");
    count.className = "term-group-count";
    count.textContent = t("profiles.groupCount", { count: bucket.items.length });
    header.append(caret, title, count);
    header.addEventListener("click", () => {
      if (collapsedGroups.has(key)) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
      renderProfileManager(root, profiles, handlers, formHolder);
    });
    section.append(header);

    const body = document.createElement("div");
    body.className = "term-group-body";
    body.hidden = collapsed;
    for (const profile of bucket.items) {
      body.append(buildProfileRow(profile, handlers));
    }
    section.append(body);
    root.append(section);
  }

  root.append(formHolder);
}

function buildProfileRow(profile: SshProfile, handlers: ProfilePanelHandlers): HTMLElement {
  const row = document.createElement("div");
  row.className = "term-profile-row";

  const info = document.createElement("div");
  info.className = "term-profile-info";
  const name = document.createElement("strong");
  name.textContent = profile.name;
  const meta = document.createElement("span");
  meta.dataset.role = "meta";
  meta.textContent = metaText(profile);
  info.append(name, meta);

  const actions = document.createElement("div");
  actions.className = "term-profile-actions";
  actions.append(
    actionButton(t("profiles.connect"), t("profiles.connectHint", { name: profile.name }), () =>
      handlers.onConnect(profile.id),
    ),
    actionButton(t("profiles.edit"), t("profiles.editHint", { name: profile.name }), () =>
      handlers.onEdit(profile),
    ),
    actionButton(t("profiles.test"), t("profiles.testHint", { name: profile.name }), () =>
      handlers.onTest(profile.id),
    ),
    actionButton(t("profiles.delete"), t("profiles.deleteHint", { name: profile.name }), () =>
      handlers.onDelete(profile.id),
    ),
  );

  row.append(info, actions);
  return row;
}

function metaText(profile: SshProfile): string {
  const parts = [`${profile.user}@${profile.host}:${profile.port}`, profile.auth];
  if (profile.hasPassword) parts.push(t("profiles.savedPassword"));
  if (profile.hasPassphrase) parts.push(t("profiles.savedPassphrase"));
  return parts.join(" · ");
}

function actionButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "term-btn";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * 新增 / 编辑表单。
 *
 * 三件必须做对的事：
 *   1. **认证方式决定字段**：agent 不要任何凭据；key 要路径（+可选口令）；
 *      password 要密码。切走时把不再适用的字段值一起清掉，避免「看不见但还
 *      存着」的旧配置。
 *   2. **已保存的秘密不回填**：后端从不下发明文，输入框留空即「保持不变」，
 *      并提供显式的「忘记已保存的…」。
 *   3. **小眼睛在输入框内部靠右**：这是用户明确的诉求，也是密码管理器之外的
 *      通用约定；按钮必须是 type=button，否则回车会提交表单。
 */
export function buildProfileForm(
  profile: SshProfile | null,
  options: {
    onCancel: () => void;
    onSubmit: (payload: Record<string, unknown>, profile: SshProfile | null) => Promise<void>;
    onReveal: (profileId: string, kind: "password" | "passphrase") => Promise<string | null>;
  },
): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "term-form";
  form.dataset.mode = profile ? "edit" : "create";
  const attr = (input: string | number | undefined): string =>
    input === undefined || input === null ? "" : escapeAttr(String(input));

  form.innerHTML = `
    <h3>${profile ? t("form.editTitle", { name: escapeAttr(profile.name) }) : t("form.addTitle")}</h3>
    <label>${t("form.name")}
      <input name="name" value="${attr(profile?.name)}" placeholder="${escapeAttr(t("form.namePlaceholder"))}" />
    </label>
    <label>${t("form.host")}
      <input name="host" required value="${attr(profile?.host)}" placeholder="${escapeAttr(t("form.hostPlaceholder"))}" />
    </label>
    <div class="term-form-row">
      <label>${t("form.port")}
        <input name="port" type="number" min="1" max="65535" value="${attr(profile?.port ?? 22)}" />
      </label>
      <label>${t("form.user")}
        <input name="user" required value="${attr(profile?.user)}" placeholder="${escapeAttr(t("form.userPlaceholder"))}" />
      </label>
    </div>
    <label>${t("form.group")}
      <input name="group" value="${attr(profile?.group)}" placeholder="${escapeAttr(t("form.groupPlaceholder"))}" list="term-group-list" />
    </label>
    <datalist id="term-group-list"></datalist>
    <label>${t("form.auth")}
      <select name="auth">
        <option value="agent">${escapeAttr(t("form.authAgent"))}</option>
        <option value="key">${escapeAttr(t("form.authKey"))}</option>
        <option value="password">${escapeAttr(t("form.authPassword"))}</option>
      </select>
    </label>
    <label data-field="privateKeyPath">${t("form.privateKeyPath")}
      <input name="privateKeyPath" value="${attr(profile?.privateKeyPath)}" placeholder="${escapeAttr(t("form.privateKeyPlaceholder"))}" />
    </label>
    <label data-field="passphrase">${t("form.passphrase")}
      <span class="term-input-wrap">
        <input name="passphrase" type="password" autocomplete="new-password"
               placeholder="${escapeAttr(
                 profile?.hasPassphrase ? t("form.passphraseSaved") : t("form.passphraseHint"),
               )}" />
        <button type="button" class="term-eye" data-eye="passphrase" aria-label="${escapeAttr(t("form.showSecret"))}" title="${escapeAttr(t("form.showSecret"))}"></button>
      </span>
    </label>
    <label data-field="password">${t("form.password")}
      <span class="term-input-wrap">
        <input name="password" type="password" autocomplete="new-password"
               placeholder="${escapeAttr(profile?.hasPassword ? t("form.passwordSaved") : t("form.passwordHint"))}" />
        <button type="button" class="term-eye" data-eye="password" aria-label="${escapeAttr(t("form.showSecret"))}" title="${escapeAttr(t("form.showSecret"))}"></button>
      </span>
    </label>
    <div class="term-form-flags">
      ${profile?.hasPassword ? `<label class="term-check" data-field="clearPassword"><input name="clearPassword" type="checkbox" /> ${t("form.clearPassword")}</label>` : ""}
      ${profile?.hasPassphrase ? `<label class="term-check" data-field="clearPassphrase"><input name="clearPassphrase" type="checkbox" /> ${t("form.clearPassphrase")}</label>` : ""}
    </div>
    <label>${t("form.initialCommand")}
      <input name="initialCommand" value="${attr(profile?.initialCommand)}" placeholder="${escapeAttr(t("form.optional"))}" />
    </label>
    <div class="term-form-actions">
      <button type="submit">${profile ? t("form.save") : t("form.create")}</button>
      ${profile ? `<button type="button" data-action="cancel">${t("form.cancel")}</button>` : ""}
    </div>
  `;

  const authSelect = form.querySelector<HTMLSelectElement>('select[name="auth"]')!;
  // 新建档案默认「密码」认证：这是最常见的入口，用户选了别的方式再切换。
  // 已保存的档案沿用自己保存时的认证方式。
  authSelect.value = profile?.auth ?? "password";

  const syncAuthFields = (): void => {
    const auth = authSelect.value;
    form.querySelector<HTMLElement>('[data-field="privateKeyPath"]')!.hidden = auth !== "key";
    form.querySelector<HTMLElement>('[data-field="passphrase"]')!.hidden = auth !== "key";
    form.querySelector<HTMLElement>('[data-field="password"]')!.hidden = auth !== "password";
    const clearPassword = form.querySelector<HTMLElement>('[data-field="clearPassword"]');
    const clearPassphrase = form.querySelector<HTMLElement>('[data-field="clearPassphrase"]');
    if (clearPassword) clearPassword.hidden = auth !== "password";
    if (clearPassphrase) clearPassphrase.hidden = auth !== "key";
    form.dataset.auth = auth;

    // 切换认证方式时清掉不再适用的输入：它们已经不会被保存（见 saveProfileForm），
    // 但还是要把界面上的残留值去掉，否则用户会以为那些值仍然生效。
    if (auth !== "key") {
      const key = form.querySelector<HTMLInputElement>('input[name="privateKeyPath"]');
      const pass = form.querySelector<HTMLInputElement>('input[name="passphrase"]');
      if (key) key.value = "";
      if (pass) {
        pass.value = "";
        pass.type = "password";
      }
      resetEye(form, "passphrase");
    }
    if (auth !== "password") {
      const password = form.querySelector<HTMLInputElement>('input[name="password"]');
      if (password) {
        password.value = "";
        password.type = "password";
      }
      const clear = form.querySelector<HTMLInputElement>('input[name="clearPassword"]');
      if (clear) clear.checked = false;
      resetEye(form, "password");
    }
    if (auth !== "key") {
      const clear = form.querySelector<HTMLInputElement>('input[name="clearPassphrase"]');
      if (clear) clear.checked = false;
    }
  };
  authSelect.addEventListener("change", syncAuthFields);
  syncAuthFields();

  // 分组联想：把已有分组名喂给 datalist，减少拼写差异。
  const groupInput = form.querySelector<HTMLInputElement>('input[name="group"]');
  const datalist = form.querySelector<HTMLDataListElement>("#term-group-list");
  if (groupInput && datalist) {
    datalist.id = `term-group-list-${Math.random().toString(36).slice(2, 8)}`;
    groupInput.setAttribute("list", datalist.id);
  }

  wireEyes(form, profile, options.onReveal);

  form.querySelector('[data-action="cancel"]')?.addEventListener("click", () => options.onCancel());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const payload = collectProfilePayload(form, profile);
      await options.onSubmit(payload, profile);
    })();
  });

  return form;
}

/** 把小眼睛接到两个秘密输入框上。 */
function wireEyes(
  form: HTMLFormElement,
  profile: SshProfile | null,
  onReveal: (profileId: string, kind: "password" | "passphrase") => Promise<string | null>,
): void {
  for (const kind of ["password", "passphrase"] as const) {
    const button = form.querySelector<HTMLButtonElement>(`[data-eye="${kind}"]`);
    const input = form.querySelector<HTMLInputElement>(`input[name="${kind}"]`);
    if (!button || !input) continue;

    input.addEventListener("input", () => {
      delete input.dataset.revealedSaved;
    });

    // 图标用内联 SVG：没有字体依赖，也不受 emoji 在不同平台的渲染差异影响。
    paintEye(button, false);

    button.addEventListener("click", () => {
      void (async () => {
        const revealed = input.type === "text";
        if (revealed) {
          input.type = "password";
          paintEye(button, false);
          setEyeLabel(button, false);
          return;
        }
        input.type = "text";
        paintEye(button, true);
        setEyeLabel(button, true);
        // 输入框是空的但档案里有已保存的密码：这才是「查看已保存密码」的场景，
        // 需要向后端要一次明文（会写审计）。输入框里有值就只切换显示，
        // 绝不把用户正在输入的内容替换掉。
        if (!input.value && profile) {
          try {
            const value = await onReveal(profile.id, kind);
            if (value !== null && !input.value) {
              input.value = value;
              input.dataset.revealedSaved = "true";
            }
          } catch {
            // 后端拒绝（没有保存的密码 / 已清除）不是错误：留用户自己输入。
          }
        }
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      })();
    });
  }
}

function setEyeLabel(button: HTMLButtonElement, shown: boolean): void {
  const label = shown ? t("form.hideSecret") : t("form.showSecret");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.dataset.shown = String(shown);
}

function resetEye(form: HTMLFormElement, kind: "password" | "passphrase"): void {
  const button = form.querySelector<HTMLButtonElement>(`[data-eye="${kind}"]`);
  if (!button) return;
  paintEye(button, false);
  setEyeLabel(button, false);
}

/**
 * 眼睛图标。
 *
 * 两态用**两套独立的图形**，而不是「同一只眼睛加一条斜线」：斜线在 16px 下
 * 会和眼形糊成一团，看起来像个被划掉的污点。隐藏态现在是一只弧线画出的
 * **闭眼 + 睫毛**（与用户提供的参考图标同构），显示态是睁眼；两者笔画粗细
 * 一致，切换时视觉重量不跳。
 */
function paintEye(button: HTMLButtonElement, shown: boolean): void {
  const open =
    '<path d="M1.6 8.4c1.85-2.6 4.05-3.9 6.4-3.9s4.55 1.3 6.4 3.9c-1.85 2.6-4.05 3.9-6.4 3.9S3.45 11 1.6 8.4Z"' +
    ' fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>' +
    '<circle cx="8" cy="8.4" r="1.8" fill="currentColor"/>';
  // 闭眼：一条向下弧的睫毛线 + 三根睫毛，与参考图标是同一个意象（不是「划掉」）。
  const closed =
    '<path d="M1.9 7.1c1.75 2.5 3.85 3.75 6.1 3.75S12.35 9.6 14.1 7.1"' +
    ' fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
    '<path d="M3.5 10 2.7 12.1M8 10.85V13M12.5 10l.8 2.1"' +
    ' fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>';
  button.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
    `${shown ? open : closed}</svg>`;
  button.dataset.shown = String(shown);
}


/** 从表单收集提交载荷；秘密字段只在对应认证方式下提交。 */
export function collectProfilePayload(
  form: HTMLFormElement,
  profile: SshProfile | null,
): Record<string, unknown> {
  const data = new FormData(form);
  const get = (key: string): string => String(data.get(key) ?? "").trim();
  const auth = get("auth");

  const payload: Record<string, unknown> = {
    ...(profile ? { id: profile.id } : {}),
    name: get("name") || get("host"),
    host: get("host"),
    port: Number(get("port")) || 22,
    user: get("user"),
    group: get("group"),
    auth,
    // 非 key 认证时显式提交空串 = 清掉私钥路径（见 profiles.ts 的注释）。
    privateKeyPath: auth === "key" ? get("privateKeyPath") : "",
    initialCommand: get("initialCommand"),
  };

  if (auth === "key") {
    const passphrase = String(data.get("passphrase") ?? "");
    if (passphrase) payload.passphrase = passphrase;
  }
  if (auth === "password") {
    const password = String(data.get("password") ?? "");
    if (password) payload.password = password;
  }
  if (data.get("clearPassword") === "on") payload.clearPassword = true;
  if (data.get("clearPassphrase") === "on") payload.clearPassphrase = true;

  // 「小眼睛」把已保存的明文填进了输入框：那个值本来就是后端的，不要当成
  // 「用户想改成这个密码」再提交一次（会多写一条审计，且在没有改动时
  // 重写密文毫无意义）。
  const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]');
  if (passwordInput?.dataset.revealedSaved === "true") delete payload.password;
  const passphraseInput = form.querySelector<HTMLInputElement>('input[name="passphrase"]');
  if (passphraseInput?.dataset.revealedSaved === "true") delete payload.passphrase;

  return payload;
}

/** 把现有分组名填进表单的 datalist（减少拼写差异）。 */
export function fillGroupSuggestions(form: HTMLFormElement, groups: string[]): void {
  const datalist = form.querySelector<HTMLDataListElement>("datalist");
  const input = form.querySelector<HTMLInputElement>('input[name="group"]');
  if (!datalist || !input) return;
  datalist.innerHTML = "";
  for (const group of groups) {
    if (!group) continue;
    const option = document.createElement("option");
    option.value = group;
    datalist.append(option);
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
