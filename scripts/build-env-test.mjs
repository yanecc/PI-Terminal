/** 把环境构造打成测试用 ESM（供 path-check 直接 import）。 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, "src/host/env.ts")],
  outfile: join(root, "dist-env-test.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node20",
  external: ["node:*"], logLevel: "warning",
});
