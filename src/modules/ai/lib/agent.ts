/**
 * 本文件负责创建语言模型并运行主 Agent 与通用 Subagent。
 * 它协调多段流、后台结果 checkpoint、工具权限和同一 turn 的最终收敛。
 */

import {
  createUIMessageStream,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type UIMessage,
} from "ai";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModelContextLimit,
  isCompatModelId,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  MLX_DEFAULT_BASE_URL,
  modelKeepsReasoning,
  OLLAMA_DEFAULT_BASE_URL,
  providerNeedsKey,
  resolveModel,
  type CustomEndpoint,
  type ProviderId,
} from "../config";
import { resolveSubagentTools, type AgentToolId } from "./agentTools";
import { buildTools, type ToolContext } from "../tools/tools";
import {
  formatSubagentResultEvent,
  releaseSubagentCoordinator,
  type SubagentResultEvent,
  type SubagentTaskRunner,
  type SubagentTurnCoordinator,
} from "../agents/subagentRuntime";
import { compactModelMessagesDetailed } from "./compact";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { prepareAgentPrompt } from "./prompt";
import { createProxyFetch } from "./proxyFetch";
import { convertToAgentModelMessages } from "./subagentMessages";

const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

const TOOL_LABELS: Record<string, (input: Record<string, unknown>) => string> =
  {
    read_file: (i) => `Reading ${shortPath(i.path)}`,
    find_files: (i) => `Finding ${shortPath(i.path ?? ".")}`,
    grep: (i) => `Grepping ${ellipsize(String(i.pattern ?? ""), 40)}`,
    apply_patch: (i) =>
      `Editing ${Array.isArray(i.files) ? i.files.length : 0} file(s)`,
    write_file: (i) => `Writing ${shortPath(i.path)}`,
    file_operation: (i) =>
      `${String(i.operation ?? "Managing")} ${shortPath(i.path)}`,
    shell_exec: (i) => `Running ${ellipsize(String(i.command ?? ""), 60)}`,
    shell_process: (i) => `${String(i.action ?? "Polling")} shell process`,
    shell_list: () => `Listing shell processes`,
    run_subagent: (i) => `Spawning ${String(i.label ?? i.task ?? "subagent")}`,
  };

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export type BuildModelOptions = {
  modelIdOverride?: string;
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
};

const modelCache = new Map<string, LanguageModel>();

export async function buildLanguageModel(
  provider: ProviderId,
  keys: ProviderKeys,
  resolvedModelId: string,
  options: BuildModelOptions = {},
  customEndpointKey?: string | null,
): Promise<LanguageModel> {
  if (providerNeedsKey(provider) && !keys[provider]) {
    throw new Error(
      `No API key configured for ${provider}. Open Settings → AI to add one.`,
    );
  }
  const key = keys[provider] ?? "";
  const lmstudioURL = options.lmstudioBaseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  const mlxURL = options.mlxBaseURL ?? MLX_DEFAULT_BASE_URL;
  const ollamaURL = options.ollamaBaseURL ?? OLLAMA_DEFAULT_BASE_URL;
  const compatURL = options.openaiCompatibleBaseURL ?? "";
  const epKey = customEndpointKey ?? "";
  const cacheKey = `${provider} ${key} ${epKey} ${resolvedModelId} ${lmstudioURL} ${mlxURL} ${ollamaURL} ${compatURL}`;
  const hit = modelCache.get(cacheKey);
  if (hit) return hit;

  let built: LanguageModel;
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = createOpenAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ apiKey: key })(resolvedModelId);
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ apiKey: key })(resolvedModelId);
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ apiKey: key })(resolvedModelId);
      break;
    }
    case "deepseek": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
      })(resolvedModelId);
      break;
    }
    case "mistral": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "mistral",
        baseURL: "https://api.mistral.ai/v1",
        apiKey: key,
      })(resolvedModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ apiKey: key })(resolvedModelId);
      break;
    }
    case "openrouter": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key,
        headers: {
          "HTTP-Referer": "https://terax.ai",
          "X-Title": "Terax",
        },
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      if (!compatURL) {
        throw new Error(
          "OpenAI-compatible provider has no base URL. Set it in Settings → Models.",
        );
      }
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compatURL,
        apiKey: epKey || key || undefined,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL: lmstudioURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "mlx": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "mlx",
        baseURL: mlxURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "ollama": {
      const { createOpenAICompatible } = await import(
        "@ai-sdk/openai-compatible"
      );
      built = createOpenAICompatible({
        name: "ollama",
        baseURL: ollamaURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive as ProviderId}`);
    }
  }
  modelCache.set(cacheKey, built);
  return built;
}

export type LocalProviderConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
};

export function buildConfiguredLanguageModel(
  modelId: string,
  keys: ProviderKeys,
  local: LocalProviderConfig = {},
): Promise<LanguageModel> {
  if (isCompatModelId(modelId)) {
    const eid = endpointIdFromCompatModel(modelId);
    const ep = local.customEndpoints?.find((e) => e.id === eid);
    if (!ep) throw new Error(`Custom endpoint not found: ${eid}`);
    if (!ep.modelId.trim()) {
      throw new Error(`${ep.name}: no model id set. Open Settings → Models.`);
    }
    return buildLanguageModel(
      "openai-compatible",
      keys,
      ep.modelId.trim(),
      { openaiCompatibleBaseURL: ep.baseURL },
      local.customEndpointKeys?.[eid],
    );
  }
  const m = resolveModel(modelId);
  let resolvedId: string = m.id;
  if (m.id === "lmstudio-local") {
    if (!local.lmstudioModelId?.trim()) {
      throw new Error(
        "LM Studio: no model id set. Open Settings → Models and enter the model id loaded in LM Studio.",
      );
    }
    resolvedId = local.lmstudioModelId.trim();
  } else if (m.id === "mlx-local") {
    if (!local.mlxModelId?.trim()) {
      throw new Error(
        "MLX: no model id set. Open Settings → Models and enter the model id served by mlx_lm.server.",
      );
    }
    resolvedId = local.mlxModelId.trim();
  } else if (m.id === "ollama-local") {
    if (!local.ollamaModelId?.trim()) {
      throw new Error(
        "Ollama: no model id set. Open Settings → Models and enter the model id (e.g. the name from `ollama list`).",
      );
    }
    resolvedId = local.ollamaModelId.trim();
  } else if (m.id === "openai-compatible-custom") {
    if (!local.openaiCompatibleModelId?.trim()) {
      throw new Error(
        "OpenAI-compatible: no model id set. Open Settings → Models.",
      );
    }
    resolvedId = local.openaiCompatibleModelId.trim();
  } else if (m.id === "openrouter-custom") {
    if (!local.openrouterModelId?.trim()) {
      throw new Error(
        "OpenRouter: no model id set. Open Settings → Models and enter an OpenRouter model id (e.g. anthropic/claude-sonnet-5).",
      );
    }
    resolvedId = local.openrouterModelId.trim();
  }
  return buildLanguageModel(m.provider, keys, resolvedId, {
    lmstudioBaseURL: local.lmstudioBaseURL,
    mlxBaseURL: local.mlxBaseURL,
    ollamaBaseURL: local.ollamaBaseURL,
    openaiCompatibleBaseURL: local.openaiCompatibleBaseURL,
  });
}

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type AgentUsageDelta = AgentUsage & {
  lastInputTokens: number;
  lastCachedTokens: number;
};

const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

export type RunAgentOptions = {
  keys: ProviderKeys;
  modelId?: string;
  systemPrompt: string;
  allowedTools: readonly AgentToolId[];
  defaultSubagentModelId?: string | null;
  maxConcurrentSubagents: number;
  subagentCoordinator: SubagentTurnCoordinator;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onSystemPrompt?: (
    systemPrompt: string,
    messages: UIMessage[],
  ) => void | Promise<void>;
  onCheckpoint: (
    completedMessages: UIMessage[],
    event: SubagentResultEvent,
  ) => void | Promise<void>;
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openaiCompatibleContextLimit?: number;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
  uiMessages: UIMessage[];
  abortSignal?: AbortSignal;
};

/**
 * 使用冻结配置启动一次可跨多个 provider 请求的 Agent turn。
 *
 * 系统提示词由会话传输层提前冻结。模型初始化前等待调用方持久化用户消息
 * 和该提示词；后台 Subagent 结果也会在恢复模型循环前 checkpoint。
 */
export async function runAgentStream(opts: RunAgentOptions) {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const endpoints = opts.customEndpoints ?? [];
  const info = resolveModel(modelId, endpoints);
  const provider = info.provider;

  await opts.onSystemPrompt?.(opts.systemPrompt, opts.uiMessages);

  const history = await convertToAgentModelMessages(opts.uiMessages);
  const keepsReasoning = modelKeepsReasoning(info);
  const prunedHistory = pruneMessages({
    messages: history,
    reasoning: keepsReasoning ? "none" : "before-last-message",
    emptyMessages: "remove",
  });
  const compatCtxOverride = isCompatModelId(modelId)
    ? endpoints.find((e) => e.id === endpointIdFromCompatModel(modelId))
        ?.contextLimit
    : opts.openaiCompatibleContextLimit;
  const model = await buildConfiguredLanguageModel(modelId, opts.keys, {
    lmstudioBaseURL: opts.lmstudioBaseURL,
    lmstudioModelId: opts.lmstudioModelId,
    mlxBaseURL: opts.mlxBaseURL,
    mlxModelId: opts.mlxModelId,
    ollamaBaseURL: opts.ollamaBaseURL,
    ollamaModelId: opts.ollamaModelId,
    openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
    openaiCompatibleModelId: opts.openaiCompatibleModelId,
    openrouterModelId: opts.openrouterModelId,
    customEndpoints: opts.customEndpoints,
    customEndpointKeys: opts.customEndpointKeys,
  });

  const subagentModelId = opts.defaultSubagentModelId ?? modelId;
  const coordinator = opts.subagentCoordinator;
  const rootTools = buildTools(
    opts.toolContext,
    opts.allowedTools,
    ({ task, label, wait, abortSignal }) => {
      const permissionMode = opts.toolContext.getPermissionMode();
      return coordinator.start({
        task,
        label,
        wait,
        limit: opts.maxConcurrentSubagents,
        parentAbortSignal: abortSignal,
        run: buildSubagentTaskRunner({
          opts,
          modelId: subagentModelId,
          permissionMode,
        }),
      });
    },
  );

  return {
    toUIMessageStream({
      originalMessages = opts.uiMessages,
      onError = (error: unknown) => String(error),
    }: {
      originalMessages?: UIMessage[];
      onError?: (error: unknown) => string;
    } = {}) {
      return createUIMessageStream<UIMessage>({
        originalMessages,
        onError,
        execute: async ({ writer }) => {
          const modelHistory: ModelMessage[] = [...prunedHistory];
          let stepsSeen = 0;
          let streamStarted = false;
          let finishReason = "stop";
          let approvalPending = false;
          let finalizationOnly = false;
          const abort = () => void coordinator.cancelAll();
          opts.abortSignal?.addEventListener("abort", abort, { once: true });

          const appendEvent = async (
            completedMessages: UIMessage[],
            event: SubagentResultEvent,
          ) => {
            await opts.onCheckpoint(completedMessages, event);
            if (!streamStarted) {
              writer.write({ type: "start" });
              streamStarted = true;
            }
            writer.write({
              type: "data-subagent-result",
              data: { event },
            });
            modelHistory.push({
              role: "user",
              content: formatSubagentResultEvent(event),
            });
          };

          /**
           * 持续取出当前已经完成的后台结果，避免写盘期间新完成的任务越过
           * 下一次 provider 请求边界。只有首个事件需要携带尚未 checkpoint 的步骤。
           */
          const appendPendingEvents = (
            completedMessages: UIMessage[],
          ): Promise<boolean> | null => {
            const firstEvent = coordinator.drainResultEvent();
            if (!firstEvent) return null;
            return (async () => {
              await appendEvent(completedMessages, firstEvent);
              while (true) {
                const event = coordinator.drainResultEvent();
                if (!event) return true;
                await appendEvent([], event);
              }
            })();
          };

          try {
            const last = originalMessages[originalMessages.length - 1];
            const initialAppend = appendPendingEvents(
              last?.role === "assistant" ? [last] : [],
            );
            if (initialAppend) await initialAppend;

            while (stepsSeen < MAX_AGENT_STEPS || finalizationOnly) {
              // 最后一次空检查与 streamText 调用之间不能 await，否则刚完成的
              // 结果可能在微任务间隙越过本次 provider 请求边界。
              while (true) {
                const pendingAppend = appendPendingEvents([]);
                if (!pendingAppend) break;
                await pendingAppend;
              }
              const compact = compactModelMessagesDetailed(
                modelHistory,
                getModelContextLimit(modelId, compatCtxOverride),
              );
              if (compact.compacted) {
                opts.onCompact?.({ droppedCount: compact.droppedCount });
                modelHistory.splice(
                  0,
                  modelHistory.length,
                  ...compact.messages,
                );
              }
              const prompt = prepareAgentPrompt(
                opts.systemPrompt,
                compact.messages,
                provider,
              );
              let cycleMessage: UIMessage | undefined;
              let cycleSteps = 0;
              const result = streamText({
                model,
                system: prompt.system,
                messages: prompt.messages,
                allowSystemInMessages: false,
                tools: finalizationOnly ? undefined : rootTools,
                stopWhen: finalizationOnly
                  ? stepCountIs(1)
                  : ({ steps }) =>
                      stepsSeen + steps.length >= MAX_AGENT_STEPS ||
                      coordinator.hasPendingResults,
                abortSignal: opts.abortSignal,
                onStepFinish: (step) => {
                  cycleSteps++;
                  reportAgentStep(opts, step);
                },
              });
              const uiStream = result.toUIMessageStream<UIMessage>({
                sendStart: !streamStarted,
                sendFinish: false,
                onError,
                onFinish: ({ responseMessage }) => {
                  cycleMessage = responseMessage;
                },
              });
              for await (const chunk of uiStream) writer.write(chunk);
              streamStarted = true;

              const [response, resultFinishReason] = await Promise.all([
                result.response,
                result.finishReason,
              ]);
              modelHistory.push(...response.messages);
              stepsSeen += cycleSteps;
              finishReason = resultFinishReason;
              approvalPending = hasApprovalRequest(cycleMessage);

              const reachedCandidateEnd = resultFinishReason !== "tool-calls";
              const mustDrainBackground =
                !approvalPending &&
                coordinator.runningCount > 0 &&
                (reachedCandidateEnd || stepsSeen >= MAX_AGENT_STEPS);
              if (mustDrainBackground) {
                await coordinator.waitForAll();
              }

              let completed = false;
              if (!approvalPending && coordinator.hasPendingResults) {
                if (!cycleMessage) {
                  throw new Error("Subagent checkpoint message is unavailable");
                }
                const pendingAppend = appendPendingEvents([cycleMessage]);
                completed = pendingAppend ? await pendingAppend : false;
              }

              if (approvalPending) break;
              if (completed) {
                finalizationOnly = stepsSeen >= MAX_AGENT_STEPS;
                continue;
              }
              break;
            }

            writer.write({
              type: "finish",
              finishReason: normalizeFinishReason(finishReason),
            });
            opts.onStep?.(null);
            opts.onFinishMeta?.({
              hitStepCap: stepsSeen >= MAX_AGENT_STEPS,
              finishReason,
            });
            if (!approvalPending) {
              coordinator.reset();
              releaseSubagentCoordinator(
                opts.toolContext.getSessionId(),
                coordinator,
              );
            }
          } catch (error) {
            await coordinator.cancelAll();
            releaseSubagentCoordinator(
              opts.toolContext.getSessionId(),
              coordinator,
            );
            throw error;
          } finally {
            opts.abortSignal?.removeEventListener("abort", abort);
          }
        },
      });
    },
  };
}

/** 按启动时权限快照创建一个不含递归能力的 Subagent runner。 */
function buildSubagentTaskRunner({
  opts,
  modelId,
  permissionMode,
}: {
  opts: RunAgentOptions;
  modelId: string;
  permissionMode: "ask" | "full-access";
}): SubagentTaskRunner {
  const allowedTools = resolveSubagentTools(opts.allowedTools, permissionMode);
  const toolContext: ToolContext = {
    ...opts.toolContext,
    getPermissionMode: () => permissionMode,
  };
  return async ({ task, abortSignal }) => {
    const childModel = await buildConfiguredLanguageModel(modelId, opts.keys, {
      lmstudioBaseURL: opts.lmstudioBaseURL,
      lmstudioModelId: opts.lmstudioModelId,
      mlxBaseURL: opts.mlxBaseURL,
      mlxModelId: opts.mlxModelId,
      ollamaBaseURL: opts.ollamaBaseURL,
      ollamaModelId: opts.ollamaModelId,
      openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
      openaiCompatibleModelId: opts.openaiCompatibleModelId,
      openrouterModelId: opts.openrouterModelId,
      customEndpoints: opts.customEndpoints,
      customEndpointKeys: opts.customEndpointKeys,
    });
    const prompt = prepareAgentPrompt(
      `${opts.systemPrompt}\n\n## SUBAGENT ROLE\nYou are a focused subagent working for the main agent. Complete only the assigned task and return a concise, evidence-based result. You cannot create other subagents.`,
      [{ role: "user", content: task }],
      resolveModel(modelId, opts.customEndpoints ?? []).provider,
    );
    const result = await generateText({
      model: childModel,
      system: prompt.system,
      messages: prompt.messages,
      tools: buildTools(toolContext, allowedTools),
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      abortSignal,
      onStepFinish: (step) => reportUsage(opts, step.usage),
    });
    const usage = result.totalUsage;
    return {
      status: "completed",
      result:
        result.text || "Task completed but no final response was generated.",
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      },
    };
  };
}

function reportAgentStep(
  opts: RunAgentOptions,
  step: Parameters<
    NonNullable<Parameters<typeof streamText>[0]["onStepFinish"]>
  >[0],
): void {
  if (opts.onStep) {
    const last = step.toolCalls?.[step.toolCalls.length - 1];
    if (last) {
      const label = TOOL_LABELS[last.toolName];
      opts.onStep(
        label
          ? label((last.input ?? {}) as Record<string, unknown>)
          : `Calling ${last.toolName}`,
      );
    } else if (step.text) {
      opts.onStep("Writing");
    }
  }
  reportUsage(opts, step.usage);
}

function reportUsage(
  opts: RunAgentOptions,
  usage:
    | Parameters<
        NonNullable<Parameters<typeof streamText>[0]["onStepFinish"]>
      >[0]["usage"]
    | undefined,
): void {
  if (!opts.onUsage || !usage) return;
  const stepInput = usage.inputTokens ?? 0;
  const stepCached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  opts.onUsage({
    inputTokens: stepInput,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: stepCached,
    lastInputTokens: stepInput,
    lastCachedTokens: stepCached,
  });
}

function hasApprovalRequest(message: UIMessage | undefined): boolean {
  return Boolean(
    message?.parts.some(
      (part) =>
        "state" in part &&
        (part as { state?: string }).state === "approval-requested",
    ),
  );
}

function normalizeFinishReason(
  value: string,
): "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" {
  if (
    value === "stop" ||
    value === "length" ||
    value === "content-filter" ||
    value === "tool-calls" ||
    value === "error"
  ) {
    return value;
  }
  return "other";
}

export { EMPTY_USAGE };
