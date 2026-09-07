/**
 * 本文件验证 Windows TUI 发行物能在非交互环境启动内嵌 Rust 宿主。
 * 在仓库外执行只读列表命令，并将 MJS 实际释放的资源与构建输入逐一比对，
 * 锁定压缩去重不会丢失内容或资源别名、回收不影响活跃实例，不读取模型凭据。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getNodeAssets } from "@opentui/core/node-assets";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(root, "artifacts", "tui", "windows-x64");

/** 运行发行物的只读列表命令，并在失败时输出受限诊断。 */
async function smoke(name: string, command: string[], cwd: string) {
  const environment = { ...process.env };
  delete environment.TERAX_NATIVE_HOST;
  delete environment.OTUI_ASSET_ROOT;
  environment.TMPDIR = cwd;
  environment.TMP = cwd;
  environment.TEMP = cwd;
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    timeout: 30_000,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code === 0) return child.pid;
  throw new Error(`${name} 启动失败 (${code})：${stderr}`);
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("TUI 打包 smoke test 只能在 Windows x64 主机执行");
}
const directory = await mkdtemp(join(tmpdir(), "terax-package-smoke-"));
try {
  const standalone = join(directory, "terax.exe");
  const runtime = join(directory, "terax.mjs");
  await copyFile(join(artifactRoot, "standalone", "terax.exe"), standalone);
  await copyFile(join(artifactRoot, "runtime", "terax.mjs"), runtime);
  const bundleRoot = join(artifactRoot, ".build", "runtime");
  const inputs = (
    await readdir(bundleRoot, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const source = join(entry.parentPath, entry.name);
      return {
        key: relative(bundleRoot, source).replaceAll("\\", "/"),
        source,
      };
    });
  inputs.push(...getNodeAssets({ platform: "win32", arch: "x64" }));
  const expected = Object.fromEntries(
    await Promise.all(
      inputs.map(async ({ key, source }) => [
        key,
        createHash("sha256")
          .update(await readFile(source))
          .digest("hex"),
      ]),
    ),
  );
  // 预加载检查先于发行入口注册退出回调，在临时目录清理前验证真实解包结果。
  const verifier = join(directory, "verify.mjs");
  await writeFile(
    verifier,
    `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
process.on("exit", () => {
  assert(process.env.OTUI_ASSET_ROOT, "Runtime assets were not extracted");
  for (const [path, hash] of Object.entries(${JSON.stringify(expected)})) {
    const bytes = readFileSync(join(process.env.OTUI_ASSET_ROOT, path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, path);
  }
});
`,
    "utf8",
  );
  const exitedPid = await smoke(
    "standalone",
    [standalone, "agent", "--list"],
    directory,
  );
  assert(exitedPid);
  const liveDirectory = join(directory, `terax-runtime-${process.pid}-live`);
  const deadDirectory = join(directory, `terax-runtime-${exitedPid}-dead`);
  await mkdir(liveDirectory);
  await mkdir(deadDirectory);
  // 活跃实例即使超过一天也必须保留，只有确认已退出的实例才能回收。
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(liveDirectory, old, old);
  await smoke(
    "runtime",
    [process.execPath, "--preload", verifier, runtime, "agent", "--list"],
    directory,
  );
  assert((await stat(liveDirectory)).isDirectory());
  await assert.rejects(stat(deadDirectory), { code: "ENOENT" });
} finally {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
process.stdout.write(
  "PASS: 两种单文件均可在仓库外启动，MJS 解包内容与所有资源路径完整\n",
);
