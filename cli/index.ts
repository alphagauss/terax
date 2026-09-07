#!/usr/bin/env bun
/**
 * 本文件是 terax 命令行应用的唯一启动入口。
 * 解析参数并按需加载子命令，统一处理退出错误；帮助不初始化业务或 TUI。
 */

import { parseArgs } from "node:util";
import en from "@/i18n/locales/en/tui.json";

/** 解析命令行参数并分发当前支持的 agent 子命令。 */
export async function main(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      cwd: { type: "string" },
      model: { type: "string" },
      resume: { type: "string" },
      list: { type: "boolean" },
      "full-access": { type: "boolean" },
    },
  });
  if (values.help || args.length === 0) {
    process.stdout.write(`${en.help}\n`);
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "agent")
    throw new Error(en.invalidArguments);
  const { runAgent } = await import("./commands/agent");
  await runAgent(values);
}

/** 运行命令入口并将未处理错误转换为一致的进程退出状态。 */
export async function runCli(args: string[]) {
  try {
    await main(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli(process.argv.slice(2));
}
