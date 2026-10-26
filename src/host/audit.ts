/**
 * 审计日志。
 *
 * 只回答「谁在什么时候对哪个会话做了什么」，**不记录终端内容、不记录凭据**。
 * 这是安全承诺的一部分：一份记满密码的审计日志比没有审计更糟。
 *
 * 实现刻意简单：追加 NDJSON，单文件超过 1 MiB 时轮转到 `.1`（只留一份旧文件）。
 * 审计失败绝不影响主流程（写盘失败只打一行 warn）。
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_BYTES = 1024 * 1024;

export class AuditLog {
  private constructor(private readonly dataDir: string) {}

  static async open(dataDir: string): Promise<AuditLog> {
    await mkdir(dataDir, { recursive: true });
    return new AuditLog(dataDir);
  }

  private get path(): string {
    return join(this.dataDir, "audit.jsonl");
  }

  async write(event: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.rotateIfNeeded();
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...redactDetail(detail) });
      await appendFile(this.path, `${line}\n`, "utf8");
    } catch (error) {
      console.warn("[pi-terminal] audit write failed", error instanceof Error ? error.message : error);
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    const info = await stat(this.path).catch(() => null);
    if (!info || info.size < MAX_BYTES) return;
    await rename(this.path, `${this.path}.1`).catch(() => undefined);
  }
}

/**
 * 细节里可能夹带路径或主机名（那是必要信息），但绝不能出现 `password` 这类
 * 键的值 —— 即便调用方误传，这里也再兜一层。
 */
function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (/pass(word|phrase)|secret|token|privatekey/i.test(key)) {
      out[key] = "«redacted»";
      continue;
    }
    if (typeof value === "string" && value.length > 512) {
      out[key] = `${value.slice(0, 512)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}
