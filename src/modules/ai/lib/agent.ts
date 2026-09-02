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
  getModelContextLimit,
  LMSTUDIO_DEFAULT_BASE_URL,
  MAX_AGENT_STEPS,
  MLX_DEFAULT_BASE_URL,
  type ModelRef,
  modelKeepsReasoning,
  OLLAMA_DEFAULT_BASE_URL,
  providerNeedsKey,
  resolveModel,
  type ProviderInstance,
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
import {
  isSubagentToolErrorOutput,
  summarizeSubagentToolInput,
  type SubagentDisplayState,
} from "../agents/subagentDisplay";
import { compactModelMessagesDetailed } from "./compact";
import type { ProviderInstanceKeys, ProviderKeys } from "./keyring";
import { prepareAgentPrompt } from "./prompt";
import { createProxyFetch } from "./proxyFetch";
import { REASONING_DURATION_PART_TYPE } from "./sessionMessages";
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
  providerInstanceKey?: string | null,
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
  const instanceKey = providerInstanceKey ?? "";
  const cacheKey = `${provider} ${key} ${instanceKey} ${resolvedModelId} ${lmstudioURL} ${mlxURL} ${ollamaURL} ${compatURL}`;
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
        apiKey: instanceKey || key || undefined,
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

export type RuntimeProviderConfig = {
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  customProviders?: readonly ProviderInstance[];
  providerInstanceKeys?: ProviderInstanceKeys;
};

export function buildConfiguredLanguageModel(
  modelRef: ModelRef,
  keys: ProviderKeys,
  config: RuntimeProviderConfig = {},
): Promise<LanguageModel> {
  const resolved = resolveModel(modelRef, config.customProviders);
  return buildLanguageModel(
    resolved.provider,
    keys,
    resolved.id,
    {
      lmstudioBaseURL: config.lmstudioBaseURL,
      mlxBaseURL: config.mlxBaseURL,
      ollamaBaseURL: config.ollamaBaseURL,
      openaiCompatibleBaseURL: resolved.baseURL,
    },
    config.providerInstanceKeys?.[resolved.providerId],
  );
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
  model: ModelRef;
  systemPrompt: string;
  allowedTools: readonly AgentToolId[];
  defaultSubagentModel?: ModelRef | null;
  maxConcurrentSubagents: number;
  subagentCoordinator: SubagentTurnCoordinator;
  toolContext: ToolContext;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onSubagentDisplay?: (state: SubagentDisplayState) => void;
  onSystemPrompt?: (
    systemPrompt: string,
    messages: UIMessage[],
  ) => void | Promise<void>;
  onCheckpoint: (
    completedMessages: UIMessage[],
    event: SubagentResultEvent,
  ) => void | Promise<void>;
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  customProviders?: readonly ProviderInstance[];
  providerInstanceKeys?: ProviderInstanceKeys;
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
  const modelRef = opts.model;
  const info = resolveModel(modelRef, opts.customProviders);
  const provider = info.provider;

  await opts.onSystemPrompt?.(opts.systemPrompt, opts.uiMessages);

  const history = await convertToAgentModelMessages(opts.uiMessages);
  const keepsReasoning = modelKeepsReasoning(info);
  const prunedHistory = pruneMessages({
    messages: history,
    reasoning: keepsReasoning ? "none" : "before-last-message",
    emptyMessages: "remove",
  });
  const model = await buildConfiguredLanguageModel(modelRef, opts.keys, {
    lmstudioBaseURL: opts.lmstudioBaseURL,
    mlxBaseURL: opts.mlxBaseURL,
    ollamaBaseURL: opts.ollamaBaseURL,
    customProviders: opts.customProviders,
    providerInstanceKeys: opts.providerInstanceKeys,
  });

  const subagentModel = opts.defaultSubagentModel ?? modelRef;
  const coordinator = opts.subagentCoordinator;
  const rootTools = buildTools(
    opts.toolContext,
    opts.allowedTools,
    ({ task, label, toolCallId, wait, abortSignal }) => {
      const permissionMode = opts.toolContext.getPermissionMode();
      return coordinator.start({
        task,
        label,
        toolCallId,
        wait,
        limit: opts.maxConcurrentSubagents,
        parentAbortSignal: abortSignal,
        onDisplay: opts.onSubagentDisplay,
        run: buildSubagentTaskRunner({
          opts,
          model: subagentModel,
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
                getModelContextLimit(info.id, info.contextLimit),
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
              let reasoningStartedAt: number | undefined;
              const reasoningDurations: number[] = [];
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
              for await (const chunk of uiStream) {
                if (chunk.type === "reasoning-start") {
                  reasoningStartedAt = performance.now();
                }
                writer.write(chunk);
                if (
                  chunk.type === "reasoning-end" &&
                  reasoningStartedAt !== undefined
                ) {
                  const durationMs = Math.max(
                    0,
                    Math.round(performance.now() - reasoningStartedAt),
                  );
                  reasoningDurations.push(durationMs);
                  writer.write({
                    type: REASONING_DURATION_PART_TYPE,
                    id: chunk.id,
                    data: { durationMs },
                  });
                  reasoningStartedAt = undefined;
                }
              }
              if (cycleMessage && reasoningDurations.length > 0) {
                let durationIndex = 0;
                const parts: UIMessage["parts"] = [];
                for (const part of cycleMessage.parts) {
                  parts.push(part);
                  if (part.type !== "reasoning") continue;
                  const durationMs = reasoningDurations[durationIndex++];
                  if (durationMs !== undefined) {
                    parts.push({
                      type: REASONING_DURATION_PART_TYPE,
                      data: { durationMs },
                    } as UIMessage["parts"][number]);
                  }
                }
                cycleMessage.parts = parts;
              }
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
  model,
  permissionMode,
}: {
  opts: RunAgentOptions;
  model: ModelRef;
  permissionMode: "ask" | "full-access";
}): SubagentTaskRunner {
  const allowedTools = resolveSubagentTools(opts.allowedTools, permissionMode);
  const toolContext: ToolContext = {
    ...opts.toolContext,
    getPermissionMode: () => permissionMode,
  };
  return async ({ task, abortSignal, onProgress }) => {
    const childModel = await buildConfiguredLanguageModel(model, opts.keys, {
      lmstudioBaseURL: opts.lmstudioBaseURL,
      mlxBaseURL: opts.mlxBaseURL,
      ollamaBaseURL: opts.ollamaBaseURL,
      customProviders: opts.customProviders,
      providerInstanceKeys: opts.providerInstanceKeys,
    });
    const prompt = prepareAgentPrompt(
      `${opts.systemPrompt}\n\n## SUBAGENT ROLE\nYou are a focused subagent working for the main agent. Complete only the assigned task and return a concise, evidence-based result. You cannot create other subagents.`,
      [{ role: "user", content: task }],
      resolveModel(model, opts.customProviders).provider,
    );
    const result = await generateText({
      model: childModel,
      system: prompt.system,
      messages: prompt.messages,
      tools: buildTools(toolContext, allowedTools),
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      abortSignal,
      experimental_onStepStart: () => {
        onProgress({ type: "thinking" });
      },
      experimental_onToolCallStart: ({ toolCall }) => {
        if (!toolCall) return;
        onProgress({
          type: "tool-start",
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
          summary: summarizeSubagentToolInput(
            toolCall.toolName,
            toolCall.input,
          ),
        });
      },
      experimental_onToolCallFinish: ({ toolCall, success, output }) => {
        if (!toolCall) return;
        onProgress({
          type: "tool-finish",
          id: toolCall.toolCallId,
          status:
            success && !isSubagentToolErrorOutput(output)
              ? "completed"
              : "failed",
        });
      },
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
