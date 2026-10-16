/**
 * 本文件测试稳定系统提示、执行环境映射与模型消息准备逻辑。
 * 重点锁定跨平台 Shell 语义、确定性文本和 Anthropic 缓存标记。
 */

import { type ModelMessage, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentPromptSections,
  buildAgentSystemPrompt,
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
    [{ kind: "local" } as const, "windows" as const, "Windows", "Windows"],
    [{ kind: "local" } as const, "macos" as const, "macOS", "macOS"],
    [{ kind: "local" } as const, "linux" as const, "Linux", "Linux"],
    [
      { kind: "wsl", distro: "Ubuntu" } as const,
      "windows" as const,
      "Linux",
      "WSL",
    ],
    [
      { kind: "ssh", profileId: "server" } as const,
      "windows" as const,
      "Linux",
      "Linux SSH",
    ],
  ])(
    "maps %j on %s to its execution environment",
    (workspace, host, platform, executionEnvironment) => {
      const shells = [
        { kind: "bash" as const, executable: "/bin/bash", version: null },
      ];
      const environment = resolveAgentExecutionEnvironment(
        workspace,
        host,
        shells,
      );
      expect(environment).toEqual({
        backend: workspace.kind,
        platform,
        shells,
      });
      const prompt = buildAgentSystemPrompt({
        cwd: "/workspace",
        environment,
        agent: { name: "Builder", instructions: "" },
        customInstructions: "",
        projectInstructions: [],
      });
      expect(prompt).toContain(
        `Execution environment: ${executionEnvironment}\nOperating system: ${platform}`,
      );
    },
  );

  it("uses the same ordered sections for configuration and requests without desktop rules leaking into Channels", () => {
    const agent = { name: "Channel", instructions: "Reply through messaging." };
    const options = {
      cwd: "/workspace",
      environment: resolveAgentExecutionEnvironment(
        { kind: "local" },
        "linux",
        [{ kind: "bash", executable: "/bin/bash", version: null }],
      ),
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

  it.each(["Linux", "macOS"] as const)(
    "uses the first available %s shell as default when Bash is missing",
    (platform) => {
      const prompt = buildAgentSystemPrompt({
        cwd: "/workspace",
        environment: {
          backend: "local",
          platform,
          shells: [
            { kind: "sh", executable: "/bin/sh", version: null },
            { kind: "zsh", executable: "/bin/zsh", version: "5.9" },
          ],
        },
        agent: { name: "Builder", instructions: "" },
        customInstructions: "",
        projectInstructions: [],
      });
      expect(prompt).toContain('Shell tool default: "sh"');
      expect(prompt).not.toContain("was not found");
      expect(prompt).toContain('"executable":"/bin/zsh","version":"5.9"');
      expect(prompt).not.toMatch(/Local|WSL|SSH|remote|Windows/);
      expect(prompt).toContain("Use POSIX syntax when selecting sh");
      expect(prompt).not.toContain("Shell execution is unavailable.");
    },
  );

  it.each(["WSL", "SSH"] as const)(
    "uses detected %s alternatives and versions",
    (workspace) => {
      const prompt = buildAgentSystemPrompt({
        cwd: "/workspace",
        environment: {
          ...resolveAgentExecutionEnvironment(
            workspace === "WSL"
              ? { kind: "wsl", distro: "Ubuntu" }
              : { kind: "ssh", profileId: "server" },
            "windows",
            [{ kind: "zsh", executable: "/bin/zsh", version: "5.9" }],
          ),
        },
        agent: { name: "Builder", instructions: "" },
        customInstructions: "",
        projectInstructions: [],
      });
      expect(prompt).toContain('Shell tool default: "zsh"');
      expect(prompt).toContain('"executable":"/bin/zsh","version":"5.9"');
      expect(prompt).toContain("Operating system: Linux");
      expect(prompt).toContain(
        `Execution environment: ${workspace === "WSL" ? "WSL" : "Linux SSH"}`,
      );
      expect(prompt).not.toMatch(/Local|remote|Windows|PowerShell|macOS/);
      expect(prompt).not.toContain(workspace === "WSL" ? "SSH" : "WSL");
      expect(prompt).not.toContain("/bin/bash");
    },
  );

  it("keeps chat prompts available when the native default shell is missing", () => {
    const environment = resolveAgentExecutionEnvironment(
      { kind: "local" },
      "windows",
      [],
    );
    const prompt = buildAgentSystemPrompt({
      cwd: "D:/workspace/project",
      environment,
      agent: { name: "Builder", instructions: "" },
      customInstructions: "",
      projectInstructions: [],
    });
    expect(prompt).toContain("Shell tool default: null");
    expect(prompt).toContain("Shell execution is unavailable.");
    expect(prompt).not.toContain(
      "executes commands directly in the default shell",
    );
  });

  it("builds deterministic normalized instructions with explicit shell context", () => {
    const options = {
      cwd: "D:/workspace/project",
      environment: {
        backend: "local",
        platform: "Windows",
        shells: [
          {
            kind: "pwsh",
            executable: "C:/Program Files/PowerShell/7/pwsh.exe",
            version: "7.1",
          },
          {
            kind: "powershell",
            executable:
              "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            version: "5.1",
          },
          {
            kind: "cmd",
            executable: "C:/Windows/System32/cmd.exe",
            version: null,
          },
        ],
      } as const,
      agent: { name: "Builder", instructions: "  Build carefully.\r\n" },
      customInstructions: "  Be direct.\r\n",
      projectInstructions: [
        { path: "AGENTS.md", content: "# Rules\r\n\r\nUse pnpm.\r\n" },
      ],
    };

    const prompt = buildAgentSystemPrompt(options);

    expect(prompt).toContain("Operating system: Windows");
    expect(prompt).toContain('Shell tool default: "pwsh"');
    expect(prompt).toContain('"version":"7.1"');
    expect(prompt).toContain('"version":"5.1"');
    expect(prompt).not.toContain('"version":null');
    expect(prompt).toContain(
      'Omitting shell or choosing "default" executes commands directly in the default shell.',
    );
    const unknownVersionPrompt = buildAgentSystemPrompt({
      ...options,
      environment: {
        ...options.environment,
        shells: [{ ...options.environment.shells[0], version: null }],
      },
    });
    expect(unknownVersionPrompt).toContain('Shell tool default: "pwsh"');
    expect(unknownVersionPrompt).toContain(
      options.environment.shells[0].executable,
    );
    expect(unknownVersionPrompt).not.toContain('"version":');
    const cmdPrompt = buildAgentSystemPrompt({
      ...options,
      environment: {
        ...options.environment,
        shells: options.environment.shells.slice(2),
      },
    });
    expect(cmdPrompt).toContain('Shell tool default: "cmd"');
    expect(cmdPrompt).not.toContain('"pwsh"');
    expect(cmdPrompt).not.toContain('"powershell"');
    expect(prompt).toContain(
      'Omitting shell or choosing "default" executes commands directly in the default shell.',
    );
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
  it("preserves protocol options when adding an Anthropic cache breakpoint", () => {
    const message: ModelMessage = {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "thought",
          providerOptions: { anthropic: { signature: "signed" } },
        },
      ],
      providerOptions: { anthropic: { custom: "preserved" } },
    };
    const snapshot = JSON.stringify(message);
    const prepared = prepareAgentPrompt("stable", [message], "anthropic");
    expect(prepared.messages[0].providerOptions?.anthropic).toEqual({
      custom: "preserved",
      cacheControl: { type: "ephemeral" },
    });
    expect(prepared.messages[0].content).toEqual(message.content);
    expect(JSON.stringify(message)).toBe(snapshot);
  });
  it("keeps trusted instructions outside conversation messages", () => {
    const prompt = prepareAgentPrompt("Stable instructions", history, "openai");

    expect(prompt.instructions).toEqual([
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

    expect(prompt.instructions[0].providerOptions).toEqual({
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
    const model = new MockLanguageModelV4({
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
        instructions: prompt.instructions,
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
