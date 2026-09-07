/**
 * 本文件是 terax 终端子命令入口，首版只提供 agent。
 * 参数与配置解析完成后才加载 TUI，帮助和会话列表不初始化终端渲染器。
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { installNativeHost } from "@/lib/nativeHost";
import { listSessions } from "@/modules/ai/lib/sessions";
import { createTerminalHost } from "./nativeHost";
import { loadTerminalSettings } from "./settings";
import en from "@/i18n/locales/en/tui.json";

/** 根据明确子命令组装共享业务和终端宿主，不更改桌面进程结构。 */
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
  if (!values.list && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(en.ttyRequired);
  const native = createTerminalHost(resolve(values.cwd ?? process.cwd()));
  installNativeHost(native.host);
  try {
    const bootstrap = await native.host.invoke<{
      cwd: string;
      protocol: number;
    }>("host_bootstrap");
    if (bootstrap.protocol !== 1)
      throw new Error(
        "Native host protocol does not match this terminal client",
      );
    if (values.list) {
      const sessions = (await listSessions()).filter(
        (session) => session.environmentKey === "local" && !session.channelId,
      );
      process.stdout.write(
        sessions.length
          ? `${sessions
              .map(
                (session) => `${session.id}\t${session.title}\t${session.cwd}`,
              )
              .join("\n")}\n`
          : `${en.noSessions}\n`,
      );
      await native.close();
      return;
    }
    const settings = await loadTerminalSettings(values.model);
    const { createAgentSession } = await import(
      "@/modules/ai/lib/agentSession"
    );
    const session = await createAgentSession({
      cwd: bootstrap.cwd,
      sessionId: values.resume,
      permissionMode: values["full-access"] ? "full-access" : "ask",
      configuration: settings.configuration,
    });
    const { showAgent } = await import("./view");
    await showAgent(session, settings.t, async () => {
      try {
        if (session.getSnapshot().owned && !session.getSnapshot().commitFailed)
          await session.stop();
      } finally {
        await native.close();
      }
    });
  } catch (error) {
    await native.close();
    throw error;
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
