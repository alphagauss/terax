/**
 * 本文件测试稳定系统提示、执行环境映射与模型消息准备逻辑。
 * 重点锁定跨平台 Shell 语义、确定性文本和 Anthropic 缓存标记。
 */

import { streamText, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentSystemPrompt,
  buildAgentPromptSections,
  composeAgentPromptSections,
  prepareAgentPrompt,
  resolveAgentExecutionEnvironment,
} from "./prompt";

const history: ModelMessage[] = [
  { role: "user", content: "Fix the issue" },
  { role: "assistant", content: "I will inspect it." },
];

describe("agent system prompt", () => {
  it.each([
    [
      { kind: "local" } as const,
      "windows" as const,
      { platform: "Windows", workspace: "Local", defaultShell: "PowerShell" },
    ],
    [
      { kind: "local" } as const,
      "macos" as const,
      { platform: "macOS", workspace: "Local", defaultShell: "Bash" },
    ],
    [
      { kind: "local" } as const,
      "linux" as const,
      { platform: "Linux", workspace: "Local", defaultShell: "Bash" },
    ],
    [
      { kind: "wsl", distro: "Ubuntu" } as const,
      "windows" as const,
      { platform: "Linux", workspace: "WSL", defaultShell: "Bash" },
    ],
    [
      { kind: "ssh", profileId: "server" } as const,
      "windows" as const,
      { platform: "Linux", workspace: "SSH", defaultShell: "Bash" },
    ],
  ])(
    "maps %j on %s to its shell execution environment",
    (workspace, host, expected) => {
      expect(resolveAgentExecutionEnvironment(workspace, host)).toEqual(
        expected,
      );
    },
  );

  it("uses the same ordered sections for configuration and requests without desktop rules leaking into Channels", () => {
    const agent = { name: "Channel", instructions: "Reply through messaging." };
    const options = {
      cwd: "/workspace",
      environment: resolveAgentExecutionEnvironment({ kind: "local" }, "linux"),
      agent,
      customInstructions: "Global rule",
      projectInstructions: [
        { path: "AGENTS.md", content: "First file" },
        { path: "docs/rules.md", content: "Second file" },
      ],
    };
    const sections = buildAgentPromptSections(options);
    expect(sections.map((section) => section.kind)).toEqual([
      "core",
      "environment",
      "workspace",
      "workspace",
      "agent",
      "custom",
    ]);
    expect(buildAgentSystemPrompt(options)).toBe(
      sections.map((section) => section.content).join("\n\n"),
    );
    expect(
      sections
        .filter((section) => section.kind === "workspace")
        .map((section) => section.content),
    ).toEqual([
      "## PROJECT INSTRUCTIONS: AGENTS.md\nFirst file",
      "## PROJECT INSTRUCTIONS: docs/rules.md\nSecond file",
    ]);
    const preview = composeAgentPromptSections({
      environment: "Runtime environment",
      workspace: ["Runtime files"],
      agent,
      customInstructions: "Global rule",
    });
    for (const kind of ["core", "agent", "custom"]) {
      expect(preview.find((section) => section.kind === kind)?.content).toBe(
        sections.find((section) => section.kind === kind)?.content,
      );
    }
    expect(buildAgentSystemPrompt(options)).not.toContain("developer terminal");
    expect(buildAgentSystemPrompt(options)).not.toContain(
      "approval UI is the confirmation",
    );
    expect(buildAgentSystemPrompt(options)).not.toContain(
      "get_terminal_output",
    );
  });

  it("builds deterministic normalized instructions with explicit shell context", () => {
    const options = {
      cwd: "D:/workspace/project",
      environment: {
        platform: "Windows",
        workspace: "Local",
        defaultShell: "PowerShell",
      } as const,
      agent: { name: "Builder", instructions: "  Build carefully.\r\n" },
      customInstructions: "  Be direct.\r\n",
      projectInstructions: [
        { path: "AGENTS.md", content: "# Rules\r\n\r\nUse pnpm.\r\n" },
      ],
    };

    const prompt = buildAgentSystemPrompt(options);

    expect(prompt).toContain("Execution environment: Windows Local");
    expect(prompt).toContain("Shell tool default: PowerShell");
    expect(prompt).toContain('Working directory: "D:/workspace/project"');

    expect(prompt).toContain(
      "## AGENT INSTRUCTIONS: Builder\nBuild carefully.",
    );
    expect(prompt).toContain("# Rules\n\nUse pnpm.");
    expect(prompt).not.toContain("\r");
    expect(buildAgentSystemPrompt(options)).toBe(prompt);
  });
});

describe("prepareAgentPrompt", () => {
  it("keeps trusted instructions outside conversation messages", () => {
    const prompt = prepareAgentPrompt("Stable instructions", history, "openai");

    expect(prompt.system).toEqual([
      { role: "system", content: "Stable instructions" },
    ]);
    expect(prompt.messages).toEqual(history);
    expect(prompt.messages.every((message) => message.role !== "system")).toBe(
      true,
    );
  });

  it("keeps Anthropic cache markers on the stable prefix and rotating tail", () => {
    const prompt = prepareAgentPrompt(
      "Stable instructions",
      history,
      "anthropic",
    );

    expect(prompt.system[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(prompt.messages[0].providerOptions).toBeUndefined();
    expect(prompt.messages[1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(history.every((message) => message.providerOptions == null)).toBe(
      true,
    );
  });

  it("does not trigger the SDK system-message warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV3({
      doStream: {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.close();
          },
        }),
      },
    });
    const prompt = prepareAgentPrompt("Stable instructions", history, "openai");

    try {
      const result = streamText({
        model,
        system: prompt.system,
        messages: prompt.messages,
        allowSystemInMessages: false,
        onError: () => {},
      });
      await result.consumeStream();
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("System messages in the prompt"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
