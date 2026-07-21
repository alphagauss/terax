/**
 * 本文件验证输入框斜杠命令生成的提示词契约。
 * 当前重点锁定 `/init` 始终使用标准 AGENTS.md 文件名。
 */

import { describe, expect, it } from "vitest";
import { tryRunSlashCommand } from "./slashCommands";

describe("tryRunSlashCommand", () => {
  it("turns /init into an AGENTS.md initialization prompt", () => {
    const outcome = tryRunSlashCommand("/init");

    expect(outcome).toMatchObject({
      kind: "send-prompt",
      commandName: "init",
    });
    if (outcome.kind === "send-prompt") {
      expect(outcome.prompt).toContain("AGENTS.md");
    }
  });
});
