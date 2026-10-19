/**
 * 本文件验证聊天传输层保持真实消息不变，并转发模型配置与冻结的系统提示。
 * 测试锁定同轮审批续跑保持快照，下一轮应用最新配置。
 */

import type { UIMessage } from "@ai-sdk/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtinProviderId,
  modelRefForProvider,
  type ProviderModels,
} from "../config";

const mocks = vi.hoisted(() => ({
  prepareWebServices: vi.fn(),
  readWorkspaceInstructions: vi.fn(),
  runAgentStream: vi.fn(),
  runExternalAgentStream: vi.fn(),
  toUIMessageStream: vi.fn(),
}));

vi.mock("@/modules/ai/web/runtime", () => ({ prepareWebServices: mocks.prepareWebServices }));

vi.mock("./agent", () => ({ runAgentStream: mocks.runAgentStream }));
vi.mock("../external-agents/runtime", async (importOriginal) => ({
  ...(await importOriginal()),
  runExternalAgentStream: mocks.runExternalAgentStream,
}));
vi.mock("./projectInstructions", () => ({
  readWorkspaceInstructions: mocks.readWorkspaceInstructions,
}));

import type { ToolContext } from "../tools/context";
import type { AgentConfiguration } from "./agentConfiguration";
import type { ParameterAssignment } from "./modelParameters";
import { createSessionTransport } from "./transport";

const environment = {
  backend: "local",
  platform: "Windows",
  shells: [{ kind: "pwsh", executable: "C:/pwsh.exe", version: "7.1" }],
} as const;

const toolContext: ToolContext = {
  getCwd: () => "D:/workspace/project",
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  getSessionId: () => "00000000-0000-4000-8000-000000000001",
  getPermissionMode: () => "ask",
  supportsApprovals: true,
};

const subagentDeps = {
  getTurnId: () => "turn-1",
  getDefaultSubagentModel: () => null,
  getMaxConcurrentSubagents: () => 3,
  getMaxAgentSteps: () => null,
  getMaxSubagentSteps: () => 32,
  onCheckpoint: vi.fn(),
};

describe("session transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspaceInstructions.mockResolvedValue([
      { path: "AGENTS.md", content: "Project instructions" },
    ]);
    mocks.toUIMessageStream.mockReturnValue("stream");
    mocks.runAgentStream.mockResolvedValue({
      toUIMessageStream: mocks.toUIMessageStream,
    });
    mocks.runExternalAgentStream.mockImplementation(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "finish" });
            controller.close();
          },
        }),
    );
  });

  it("passes the canonical messages unchanged and reads instructions from session cwd", async () => {
    const providerModels: ProviderModels = {
      [builtinProviderId("openai")]: [
        { id: "model", source: "manual", contextWindow: 250_000 },
      ],
    };
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Inspect this" }],
      },
    ];
    const transport = createSessionTransport({
      getKeys: () => ({}) as never,
      toolContext,
      getModel: () => modelRefForProvider("openai", "model"),
      getProviderModels: () => providerModels,
      ...subagentDeps,
      getCustomInstructions: () => "",
      getAgent: () => ({
        revision: 1,
        id: "builtin:main",
        name: "Terax",
        instructions: "",
        description: "",
        workspaceFiles: ["AGENTS.md"],
        icon: "coder",
        tools: ["read_file"],
      }),
      getCwd: () => "D:/workspace/project",
      getEnvironment: async () => environment,
    });

    await transport.sendMessages({ messages });

    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledWith(
      "D:/workspace/project",
      ["AGENTS.md"],
    );
    expect(mocks.runAgentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining(
          'Working directory: "D:/workspace/project"',
        ),
        uiMessages: messages,
        providerModels,
        maxAgentSteps: null,
        maxSubagentSteps: 32,
      }),
    );
    expect(mocks.runAgentStream.mock.calls[0][0].uiMessages).toBe(messages);
    expect(messages[0].parts).toEqual([{ type: "text", text: "Inspect this" }]);
  });

  it("freezes approval continuations and reloads settings and files on the next turn", async () => {
    let turnId = "turn-1";
    let modelId = "model-a";
    const parameters: ParameterAssignment[] = [
      { target: "provider", path: "reasoning_effort", value: "low" },
    ];
    const subagentParameters: ParameterAssignment[] = [
      { target: "provider", path: "reasoning_effort", value: "medium" },
    ];
    let customInstructions = "First preference";
    let agent: AgentConfiguration = {
      revision: 1,
      id: "agent-a",
      name: "Builder",
      instructions: "First agent",
      description: "",
      workspaceFiles: ["AGENTS.md"],
      icon: "spark",
      tools: ["read_file"],
    };
    const getEnvironment = vi.fn(async () => environment);
    const transport = createSessionTransport({
      getKeys: () => ({}) as never,
      toolContext,
      getModel: () => modelRefForProvider("openai", modelId),
      getModelParameters: (_model, subagent) =>
        subagent ? subagentParameters : parameters,
      ...subagentDeps,
      getTurnId: () => turnId,
      getCustomInstructions: () => customInstructions,
      getAgent: () => agent,
      getCwd: () => "D:/workspace/project",
      getEnvironment,
    });
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "First" }],
      },
    ];

    const firstSend = transport.sendMessages({ messages });
    modelId = "model-b";
    parameters[0].value = "high";
    subagentParameters[0].value = "low";
    await firstSend;
    customInstructions = "Second preference";
    agent = {
      revision: 2,
      id: "agent-a",
      name: "Reviewer",
      instructions: "Second agent",
      description: "",
      workspaceFiles: ["AGENTS.md"],
      icon: "reviewer",
      tools: ["grep"],
    };
    mocks.readWorkspaceInstructions.mockResolvedValue([
      { path: "AGENTS.md", content: "Changed project instructions" },
    ]);
    await transport.sendMessages({ messages });

    const firstRun = mocks.runAgentStream.mock.calls[0][0];
    const childConfig = firstRun.getSubagentConfiguration(firstRun.model);
    expect(childConfig.model).toEqual(modelRefForProvider("openai", "model-a"));
    expect(childConfig.modelParameters[0].value).toBe("low");
    subagentParameters[0].value = "high";
    expect(
      firstRun.getSubagentConfiguration(firstRun.model).modelParameters[0]
        .value,
    ).toBe("high");
    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(1);
    expect(getEnvironment).toHaveBeenCalledTimes(1);
    const firstPrompt = mocks.runAgentStream.mock.calls[0][0].systemPrompt;
    const secondPrompt = mocks.runAgentStream.mock.calls[1][0].systemPrompt;
    expect(secondPrompt).toBe(firstPrompt);
    expect(firstPrompt).toContain(JSON.stringify(environment.shells));
    expect(firstRun.toolContext.environment).toEqual(environment);
    expect(mocks.runAgentStream.mock.calls[1][0].toolContext.environment).toBe(
      firstRun.toolContext.environment,
    );
    expect(mocks.runAgentStream.mock.calls[0][0].modelParameters[0].value).toBe(
      "low",
    );
    expect(mocks.runAgentStream.mock.calls[1][0].modelParameters[0].value).toBe(
      "low",
    );
    expect(mocks.runAgentStream.mock.calls[1][0].model).toEqual(
      modelRefForProvider("openai", "model-a"),
    );
    expect(firstPrompt).toContain("Project instructions");
    expect(firstPrompt).toContain("First agent");
    expect(firstPrompt).toContain("First preference");
    expect(firstPrompt).not.toContain("Second agent");
    expect(mocks.runAgentStream.mock.calls[0][0].allowedTools).toEqual([
      "read_file",
    ]);
    expect(mocks.runAgentStream.mock.calls[1][0].allowedTools).toEqual([
      "read_file",
    ]);
    turnId = "turn-2";
    await transport.sendMessages({ messages });
    const next = mocks.runAgentStream.mock.calls[2][0];
    expect(next.model).toEqual(modelRefForProvider("openai", "model-b"));
    expect(next.modelParameters[0].value).toBe("high");
    expect(next.systemPrompt).toContain("Second agent");
    expect(next.systemPrompt).toContain("Second preference");
    expect(next.systemPrompt).toContain("Changed project instructions");
    expect(next.allowedTools).toEqual(["grep"]);
    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(2);
    expect(getEnvironment).toHaveBeenCalledTimes(2);

    // 单独修改文档不触发初始化，下一轮仍复用完整配置。
    mocks.readWorkspaceInstructions.mockResolvedValue([
      { path: "AGENTS.md", content: "Latest file contents" },
    ]);
    turnId = "turn-3";
    await transport.sendMessages({ messages });
    expect(mocks.runAgentStream.mock.calls[3][0].systemPrompt).toBe(
      next.systemPrompt,
    );
    expect(mocks.runAgentStream.mock.calls[3][0].allowedTools).toBe(
      next.allowedTools,
    );
    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(2);
    expect(getEnvironment).toHaveBeenCalledTimes(2);

    // 仅修改全局指令也必须重新读取文档。
    customInstructions = "Third preference";
    turnId = "turn-4";
    await transport.sendMessages({ messages });
    expect(mocks.runAgentStream.mock.calls[4][0].systemPrompt).toContain(
      "Third preference",
    );
    expect(mocks.runAgentStream.mock.calls[4][0].systemPrompt).toContain(
      "Latest file contents",
    );
    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(3);

    // 仅修改智能体提示词同样完整初始化，即使文件列表不变。
    agent = { ...agent, revision: 3, instructions: "Third agent" };
    turnId = "turn-5";
    await transport.sendMessages({ messages });
    expect(mocks.runAgentStream.mock.calls[5][0].systemPrompt).toContain(
      "Third agent",
    );
    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(4);
    agent = { ...agent, revision: 4, workspaceFiles: ["docs/rules.md"] };
    turnId = "turn-6";
    await transport.sendMessages({ messages });
    expect(mocks.readWorkspaceInstructions).toHaveBeenLastCalledWith(
      "D:/workspace/project",
      ["docs/rules.md"],
    );
    expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(5);
  });

  it("routes External Agents before reading project instructions or building a model", async () => {
    const persist = vi.fn();
    const capture = vi.fn();
    const messages: UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Inspect this" }],
      },
    ];
    const transport = createSessionTransport({
      getKeys: () => ({}) as never,
      toolContext,
      getModel: () => modelRefForProvider("openai", "unused"),
      ...subagentDeps,
      getCustomInstructions: () => "unused",
      getAgent: () => ({
        revision: 1,
        id: "builtin:main",
        name: "Terax",
        instructions: "",
        description: "",
        workspaceFiles: ["AGENTS.md"],
        icon: "coder",
        tools: ["read_file"],
      }),
      getCwd: () => "D:/workspace/project",
      getEnvironment: async () => environment,
      getExternalAgent: () => ({ agentId: "claude", sessionId: "session-1" }),
      getPermissionMode: () => "ask",
      onSystemPrompt: persist,
      onExternalSession: capture,
    });

    const stream = await transport.sendMessages({ messages });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual([{ type: "finish" }]);
    expect(persist).toHaveBeenCalledWith("", messages);
    expect(mocks.readWorkspaceInstructions).not.toHaveBeenCalled();
    expect(mocks.runAgentStream).not.toHaveBeenCalled();
    expect(mocks.runExternalAgentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "claude",
        externalSessionId: "session-1",
        cwd: "D:/workspace/project",
        messages,
      }),
    );
  });
});


it("keeps web service snapshots across approval continuation and refreshes on the next turn", async () => {
  mocks.runAgentStream.mockResolvedValue({ toUIMessageStream: () => new ReadableStream({ start(controller) { controller.close(); } }) });
  mocks.readWorkspaceInstructions.mockResolvedValue([]);
  const first = { search: vi.fn() };
  const second = { fetch: vi.fn() };
  mocks.prepareWebServices.mockReturnValueOnce(first).mockReturnValueOnce(second);
  let turnId = "web-turn-1";
  let key = "first-key";
  const transport = createSessionTransport({
    ...subagentDeps,
    getTurnId: () => turnId,
    getKeys: () => ({ deepseek: key }) as never,
    toolContext,
    getModel: () => modelRefForProvider("openai", "model"),
    getCustomInstructions: () => "",
    getAgent: () => ({ revision: 1, id: "builtin:main", name: "Terax", instructions: "", description: "", workspaceFiles: [], icon: "coder", tools: ["web_search", "web_fetch"] }),
    getCwd: () => "D:/workspace/project",
    getEnvironment: () => environment,
  });
  await transport.sendMessages({ messages: [] });
  key = "next-key";
  await transport.sendMessages({ messages: [] });
  expect(mocks.prepareWebServices).toHaveBeenCalledTimes(1);
  expect(mocks.runAgentStream.mock.lastCall?.[0].toolContext.webServices).toBe(first);
  turnId = "web-turn-2";
  await transport.sendMessages({ messages: [] });
  expect(mocks.prepareWebServices).toHaveBeenLastCalledWith("next-key", undefined);
  expect(mocks.runAgentStream.mock.lastCall?.[0].toolContext.webServices).toBe(second);
});


it("applies tool availability through agent revisions only on a new turn", async () => {
  const { publishAgentConfigurations, readAgentConfiguration } = await import("./agentConfiguration");
  const { MAIN_AGENT } = await import("./agentDefinition");
  mocks.runAgentStream.mockClear();
  mocks.readWorkspaceInstructions.mockClear().mockResolvedValue([]);
  mocks.prepareWebServices.mockReturnValue({ search: vi.fn() });
  const agent = { ...MAIN_AGENT, tools: ["web_search"] as ["web_search"] };
  publishAgentConfigurations([agent], { web_search: true });
  let turnId = "availability-1";
  const transport = createSessionTransport({
    ...subagentDeps, getTurnId: () => turnId,
    getKeys: () => ({ deepseek: "key" }) as never, toolContext,
    getModel: () => modelRefForProvider("openai", "model"),
    getCustomInstructions: () => "",
    getAgent: () => readAgentConfiguration(agent.id),
    getCwd: () => "D:/workspace/project", getEnvironment: () => environment,
  });
  const messages: UIMessage[] = [{ id: "history", role: "user", parts: [{ type: "text", text: "Existing conversation" }] }];
  await transport.sendMessages({ messages });
  publishAgentConfigurations([agent], { web_search: false });
  await transport.sendMessages({ messages });
  expect(mocks.runAgentStream.mock.lastCall?.[0].allowedTools).toEqual(["web_search"]);
  expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(1);
  turnId = "availability-2";
  await transport.sendMessages({ messages });
  expect(mocks.runAgentStream.mock.lastCall?.[0].allowedTools).toEqual([]);
  expect(mocks.runAgentStream.mock.lastCall?.[0].uiMessages).toBe(messages);
  expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(2);
  publishAgentConfigurations([agent], { web_search: true });
  turnId = "availability-3";
  await transport.sendMessages({ messages });
  expect(mocks.runAgentStream.mock.lastCall?.[0].allowedTools).toEqual(["web_search"]);
  expect(mocks.readWorkspaceInstructions).toHaveBeenCalledTimes(3);
  expect(agent.tools).toEqual(["web_search"]);
});
