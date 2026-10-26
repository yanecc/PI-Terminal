/**
 * 把 SSH 传输层（含会话与工厂）、known_hosts 与 SFTP 传输打成测试用 ESM bundle。
 *
 * ssh2 是 CommonJS 且带可选原生依赖，bundle 时保持外部，让 Node 运行时解析。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // ssh2 / ssh2-sftp-client 都是 CommonJS：保持外部，让 Node 运行时解析。
  external: ["node:*", "ssh2", "ssh2-sftp-client", "cpu-features", "nan"],
  logLevel: "warning",
};

await build({ ...common, entryPoints: [join(root, "src/host/transport/ssh.ts")], outfile: join(root, "dist-ssh-test.mjs") });
await build({ ...common, entryPoints: [join(root, "src/host/ssh/known-hosts.ts")], outfile: join(root, "dist-known-hosts-test.mjs") });
await build({ ...common, entryPoints: [join(root, "src/host/ssh/sftp.ts")], outfile: join(root, "dist-sftp-test.mjs") });
// 凭据存储也要能单独驱动：「删除是否真的清了密钥库条目」只能用假工具验证。
await build({ ...common, entryPoints: [join(root, "src/host/ssh/secrets.ts")], outfile: join(root, "dist-secrets-test.mjs") });
// 档案存储也要能单独驱动：「删档案时密钥库删不掉，档案必须留着」是行为契约。
await build({ ...common, entryPoints: [join(root, "src/host/ssh/profiles.ts")], outfile: join(root, "dist-profiles-test.mjs") });
// 整条「会话 + 工厂 + 传输」链路也要能在测试里驱动（指纹确认就横跨这三层），
// 所以把它们各自打成一个 bundle，脚本按需 import。
await build({ ...common, entryPoints: [join(root, "src/host/sessions.ts")], outfile: join(root, "dist-sessions-test.mjs") });
await build({ ...common, entryPoints: [join(root, "src/host/factory.ts")], outfile: join(root, "dist-factory-test.mjs") });
console.log("[test] ssh bundles ready");
