import { assert, describe, expect, it } from "vitest";
import {
  COMMANDS,
  parseCommand,
  resolveCommand,
} from "@/modules/ai/commands/registry";

function command(text: string) {
  const parsed = parseCommand(text);
  assert(parsed);
  return parsed;
}

const source = { kind: "desktop" as const };
const t = (key: string) => key;
const context = { sessionId: "session", source, t };

describe("会话命令", () => {
  it("名称和别名共用定义，参数原文不参与名称归一化", () => {
    expect(parseCommand(" /H ")?.definition).toBe(
      COMMANDS.find((entry) => entry.name === "help"),
    );
    expect(
      parseCommand('/agent Reviewer "Keep Case"\nnext line'),
    ).toMatchObject({ name: "agent", args: 'Reviewer "Keep Case"\nnext line' });
    for (const text of [
      "/usr/bin",
      "read /help",
      "#init",
      "https://example.com",
      "/home/user.txt",
    ])
      expect(parseCommand(text)).toBeNull();
  });

  it("帮助从可用注册表生成，未知命令、参数和附件不会进入模型", async () => {
    expect(
      await resolveCommand(command("/compact 保留测试结果"), context),
    ).toEqual({ kind: "compact", instructions: "保留测试结果" });
    expect(
      await resolveCommand(command("/compact"), context, true),
    ).toMatchObject({ kind: "reply", error: true });
    const help = await resolveCommand(command("/h"), context);
    expect(help).toMatchObject({ kind: "reply" });
    if (help.kind === "reply") {
      expect(help.text).toContain("/help (/h)");
      expect(help.text).toContain("/init");
    }
    for (const text of ["/helo", "/help extra", "/init extra"])
      expect(await resolveCommand(command(text), context)).toMatchObject({
        kind: "reply",
        error: true,
      });
    expect(await resolveCommand(command("/init"), context, true)).toMatchObject(
      {
        kind: "reply",
        error: true,
      },
    );
    expect(await resolveCommand(command("/init"), context)).toMatchObject({
      kind: "task",
      prompt: expect.stringContaining("AGENTS.md"),
    });
  });
});
