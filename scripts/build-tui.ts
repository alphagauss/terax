/**
 * 本文件构建 Windows x64 的 Terax TUI 单文件发行物。
 * 独立模式嵌入 Bun runtime，外部运行时模式内嵌 Rust 与 OpenTUI 运行资源；两者
 * 均使用独立 artifacts 目录，绝不写入桌面应用使用的 src-tauri/target。
 */

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { getNodeAssets } from "@opentui/core/node-assets";

type BuildMode = "runtime" | "standalone";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetRoot = join(root, "artifacts", "tui", "windows-x64");
const cargoTarget = join(targetRoot, "cargo");
const generatedRoot = join(targetRoot, ".build");
const hostExecutable = join(cargoTarget, "release", "terax-host.exe");

/** 验证当前构建机器与请求的 Windows x64 发行目标一致。 */
function assertWindowsX64() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("TUI Windows x64 构建只能在 Windows x64 主机执行");
  }
}

/** 运行必须成功的构建子进程，并把输出直接交给调用终端。 */
function run(command: string[]) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`构建命令失败：${command.join(" ")}`);
}

/** 把绝对路径转换为生成入口可稳定解析的相对 ESM 路径。 */
function importPath(from: string, to: string) {
  const path = relative(dirname(from), to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

/** 生成调用统一 CLI 入口并注册内嵌 Rust 宿主的发布入口。 */
async function writeEntry(mode: BuildMode) {
  const entry = join(generatedRoot, `${mode}.ts`);
  const nativeHost = importPath(entry, join(root, "cli", "nativeHost.ts"));
  const index = importPath(entry, join(root, "cli", "index.ts"));
  const host = importPath(entry, hostExecutable);
  const executable =
    mode === "standalone"
      ? "hostPath"
      : "fileURLToPath(new URL(hostPath, import.meta.url))";
  await writeFile(
    entry,
    `import { fileURLToPath } from "node:url";\nimport { setPackagedNativeHost } from ${JSON.stringify(nativeHost)};\nimport { runCli } from ${JSON.stringify(index)};\nimport hostPath from ${JSON.stringify(host)} with { type: "file" };\nsetPackagedNativeHost({ executable: ${executable}, embedded: ${mode === "standalone"} });\nawait runCli(process.argv.slice(2));\n`,
    "utf8",
  );
  return entry;
}

/**
 * 把运行时 bundle 与其 OpenTUI 资源封装为一个外部 Bun 可执行的模块。
 *
 * OpenTUI 的 DLL、WASM 与 worker 均按 `import.meta.url` 寻址，因此必须和入口
 * 一起释放到同一临时目录，不能只内嵌 Rust 宿主。相同内容只编码一次，
 * gzip 压缩后的资源表随入口内嵌，解包时恢复全部路径。
 */
async function writeRuntimeBootstrap(bundleRoot: string, output: string) {
  const assets = (
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
  // OpenTUI 的 Bun bundle 使用短文件名，但其 native loader 通过稳定资源键查找 DLL。
  // 额外保留官方键路径，避免让 DLL 相对用户执行命令时所在目录解析。
  assets.push(...getNodeAssets({ platform: "win32", arch: "x64" }));
  const byContent = new Map<string, string[]>();
  for (const { key, source } of assets) {
    const data = (await readFile(source)).toString("base64");
    const paths = byContent.get(data);
    if (paths) paths.push(key);
    else byContent.set(data, [key]);
  }
  const resources = Array.from(byContent, ([data, paths]) => ({ paths, data }));
  const payload = gzipSync(JSON.stringify(resources), { level: 9 }).toString(
    "base64",
  );
  await writeFile(
    output,
    `import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
const payload = ${JSON.stringify(payload)};
const runtimeRoot = tmpdir();
for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
  const owner = /^terax-runtime-(\\d+)-/.exec(entry.name);
  if (!entry.isDirectory() || !owner) continue;
  try {
    process.kill(Number(owner[1]), 0);
    continue;
  } catch (error) {
    if (error.code !== "ESRCH") continue;
  }
  // 只回收确认已退出的进程，目录年龄不能代表实例已结束。
  try { rmSync(join(runtimeRoot, entry.name), { recursive: true, force: true }); } catch {}
}
const directory = mkdtempSync(join(runtimeRoot, "terax-runtime-" + process.pid + "-"));
process.on("exit", () => {
  // Windows 仍占用的 DLL 留给下一次启动回收，不影响退出状态。
  try { rmSync(directory, { recursive: true, force: true }); } catch {}
});
// 同一份二进制只解码一次，但保留 Bun 与 OpenTUI 各自需要的资源路径。
for (const { paths, data } of JSON.parse(gunzipSync(Buffer.from(payload, "base64")).toString("utf8"))) {
  const contents = Buffer.from(data, "base64");
  for (const relativePath of paths) {
    const target = resolve(directory, relativePath);
    if (!target.startsWith(directory + sep))
      throw new Error("Invalid embedded runtime asset path");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, { flag: "wx" });
  }
}
process.env.OTUI_ASSET_ROOT ??= directory;
await import(pathToFileURL(join(directory, "runtime.js")).href);
`,
    "utf8",
  );
}

/** 构建指定模式，并将唯一的可分发文件写入对应发行目录。 */
async function build(mode: BuildMode) {
  assertWindowsX64();
  await mkdir(generatedRoot, { recursive: true });
  run([
    "cargo",
    "build",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--no-default-features",
    "--features",
    "headless",
    "--bin",
    "terax-host",
    "--release",
    "--locked",
    "--target-dir",
    cargoTarget,
  ]);
  const entry = await writeEntry(mode);
  const output = join(
    targetRoot,
    mode,
    mode === "standalone" ? "terax.exe" : "terax.mjs",
  );
  await mkdir(dirname(output), { recursive: true });
  const command = ["bun", "build", entry, "--target=bun", "--minify"];
  if (mode === "standalone") {
    command.splice(3, 0, "--compile");
    command.push("--outfile", output);
    run(command);
  } else {
    const bundleRoot = join(generatedRoot, "runtime");
    await rm(bundleRoot, { recursive: true, force: true });
    await mkdir(bundleRoot, { recursive: true });
    command.push(
      "--define",
      'process.platform="win32"',
      "--define",
      'process.arch="x64"',
      "--outdir",
      bundleRoot,
    );
    run(command);
    await writeRuntimeBootstrap(bundleRoot, output);
  }
  process.stdout.write(`已生成 ${output}\n`);
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "mjs")) {
  throw new Error("用法：pnpm build tui [mjs]");
}
await build(args[0] === "mjs" ? "runtime" : "standalone");
