/**
 * 本文件组装 agent 子命令的配置、共享业务运行时与原生宿主。
 * 会话列表直接输出，交互运行才加载 TUI；不实现模型循环或文件策略。
 */

import { resolve } from "node:path";
import { installNativeHost } from "@/lib/nativeHost";
import { listSessions } from "@/modules/ai/lib/sessions";
import { createTerminalHost } from "../nativeHost";
import { loadTerminalSettings } from "../settings";
import en from "@/i18n/locales/en/tui.json";

/** 根据已解析参数列出会话或启动交互，并负责原生宿主的退出清理。 */
export async function runAgent(values: {
  cwd?: string;
  model?: string;
  resume?: string;
  list?: boolean;
  "full-access"?: boolean;
}) {
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
    const { showAgent } = await import("../tui/AgentView");
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
