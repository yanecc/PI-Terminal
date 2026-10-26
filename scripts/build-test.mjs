/**
 * 把 src 里的纯逻辑模块打成一个测试用 ESM bundle。
 *
 * 为什么不在测试里直接跑 ts：`node --test` 不认 TypeScript，而引入 ts-node/tsx
 * 会给这个插件加一条与运行时代码无关的依赖链。用 esbuild 一次性 bundle，
 * 测试跑的是**将要发布的同一份源码**，也不引入额外运行时。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, "test/entry.ts")],
  outfile: join(root, "test/.build/test-bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["node:*", "ssh2", "@particle-academy/fancy-pty"],
  logLevel: "warning",
});
console.log("[test] bundle ready");
