/**
 * 本文件分发前端与 TUI 构建命令。
 * 默认通过 Node 并行执行 TypeScript 检查和 Vite 构建，仅 TUI 构建需要 Bun。
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

/** 顺序执行构建步骤，任何失败立即终止并保留非零退出码。 */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** 并行执行相互独立的前端构建步骤，并在全部结束后传递失败退出码。 */
async function runParallel(commands) {
  const results = await Promise.all(
    commands.map(
      ([command, args]) =>
        new Promise((resolve) => {
          const child = spawn(command, args, {
            cwd: root,
            stdio: "inherit",
            windowsHide: true,
          });
          child.once("error", (error) => {
            process.stderr.write(`${error.message}\n`);
            resolve(1);
          });
          child.once("close", (code) => resolve(code ?? 1));
        }),
    ),
  );
  const failure = results.find((code) => code !== 0);
  if (failure !== undefined) process.exit(failure);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  await runParallel([
    [process.execPath, [require.resolve("typescript/bin/tsc")]],
    [
      process.execPath,
      [
        join(dirname(require.resolve("vite/package.json")), "bin/vite.js"),
        "build",
      ],
    ],
  ]);
} else if (args[0] === "tui") {
  run("bun", [join(root, "scripts/build-tui.ts"), ...args.slice(1)]);
} else {
  process.stderr.write("用法：pnpm build [tui [mjs]]\n");
  process.exitCode = 1;
}
