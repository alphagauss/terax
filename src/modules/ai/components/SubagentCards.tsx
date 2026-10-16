/** 按父轮次聚合子任务卡片；历史范围截止到所属轮次，进度订阅留在各卡片内部。 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import type {
  SubagentDisplaySnapshot,
  SubagentDisplayState,
} from "@/modules/ai/agents/subagentDisplay";
import { useChatDisplayStore } from "@/modules/ai/hooks/chatDisplay";
import { messageMetadata } from "@/modules/ai/lib/conversation";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  SubagentCard,
  type SubagentResultView,
} from "@/modules/ai/components/SubagentCard";
import { useTranslation } from "react-i18next";

import type { FileEditCall } from "@/modules/ai/lib/fileEdits";

type ToolPart = ToolUIPart | DynamicToolUIPart;
type Display = SubagentDisplaySnapshot | SubagentDisplayState;
export type SubagentExecution = {
  part: ToolPart;
  display: Display;
  number: number;
  current: boolean;
  fileEditCalls?: readonly FileEditCall[];
};
export type SubagentCardGroup = {
  anchor: ToolPart;
  id: string;
  executions: SubagentExecution[];
};
const Groups = createContext<ReadonlyMap<ToolPart, SubagentCardGroup>>(
  new Map(),
);

/** 只派生展示关联，不修改工具调用、结果或模型消息。 */
export function groupSubagentCards(
  messages: readonly UIMessage[],
  live: Readonly<Record<string, Display>>,
): Map<ToolPart, SubagentCardGroup> {
  const histories = new Map<string, SubagentExecution[]>();
  const groups = new Map<string, SubagentCardGroup>();
  const byCall = new Map<ToolPart, SubagentCardGroup>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!("toolCallId" in part)) continue;
      const tool = part as ToolPart;
      const display =
        messageMetadata(message).subagents?.displaysByToolCallId.get(
          part.toolCallId,
        ) ?? live[part.toolCallId];
      if (!display?.parentTurnId || byCall.has(tool)) continue;
      const key = `${display.parentTurnId}:${display.taskId}`;
      const history = histories.get(display.taskId) ?? [];
      const execution = {
        part: part as ToolPart,
        display,
        number: history.length + 1,
        current: true,
        fileEditCalls: messageMetadata(message).fileEdits?.calls,
      };
      let group = groups.get(key);
      if (!group) {
        group = {
          anchor: tool,
          id: key,
          executions: history.map((item) => ({ ...item, current: false })),
        };
        groups.set(key, group);
      }
      group.executions.push(execution);
      history.push(execution);
      histories.set(display.taskId, history);
      byCall.set(tool, group);
    }
  }
  return byCall;
}

export function SubagentCardsProvider({
  sessionId,
  messages,
  children,
}: {
  sessionId: string;
  messages: readonly UIMessage[];
  children: ReactNode;
}) {
  // 工具进度变化不重建全会话分组，只观察执行身份的加入。
  const identities = useChatDisplayStore(useChatStore, (state) =>
    JSON.stringify(
      Object.values(state.subagentDisplaysBySession[sessionId] ?? {}).map(
        ({ toolCallId, taskId, parentTurnId }) => [
          toolCallId,
          taskId,
          parentTurnId,
        ],
      ),
    ),
  );
  const groups = useMemo(() => {
    void identities;
    return groupSubagentCards(
      messages,
      useChatStore.getState().subagentDisplaysBySession[sessionId] ?? {},
    );
  }, [messages, sessionId, identities]);
  return <Groups.Provider value={groups}>{children}</Groups.Provider>;
}

export function GroupedSubagentCard({
  sessionId,
  part,
  persistedDisplay,
  backgroundResult,
}: {
  sessionId: string;
  part: ToolPart;
  persistedDisplay?: SubagentDisplaySnapshot;
  backgroundResult?: SubagentResultView;
}) {
  const { t } = useTranslation("ai");
  const group = useContext(Groups).get(part);
  const anchorId = `subagent-${sessionId}-${group?.id ?? part.toolCallId}`;
  if (group && group.anchor !== part) {
    const execution = group.executions.find((item) => item.part === part);
    return (
      <button
        type="button"
        data-chat-scroll-preserve
        className="w-fit text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => {
          const card = document.getElementById(anchorId);
          card?.scrollIntoView({ block: "nearest" });
          card
            ?.querySelector<HTMLButtonElement>("button[data-state]")
            ?.focus({ preventScroll: true });
        }}
      >
        {t("chat.subagent.continueExecution", {
          taskId: execution?.display.taskId,
          number: execution?.number,
        })}
      </button>
    );
  }
  return (
    <div id={anchorId}>
      <LiveSubagentCard
        sessionId={sessionId}
        part={part}
        persistedDisplay={persistedDisplay}
        backgroundResult={backgroundResult}
        group={group}
      />
    </div>
  );
}

/** 只有实际卡片订阅执行进度，定位入口不订阅工具事件。 */
function LiveSubagentCard({
  sessionId,
  part,
  persistedDisplay,
  backgroundResult,
  group,
}: {
  sessionId: string;
  part: ToolPart;
  persistedDisplay?: SubagentDisplaySnapshot;
  backgroundResult?: SubagentResultView;
  group?: SubagentCardGroup;
}) {
  const displays = useChatDisplayStore(
    useChatStore,
    useShallow((state) =>
      (group?.executions ?? []).map((item) =>
        "version" in item.display
          ? item.display
          : (state.subagentDisplaysBySession[sessionId]?.[
              item.part.toolCallId
            ] ?? item.display),
      ),
    ),
  );
  const live = useChatDisplayStore(
    useChatStore,
    (state) => state.subagentDisplaysBySession[sessionId]?.[part.toolCallId],
  );
  return (
    <SubagentCard
      sessionId={sessionId}
      part={part}
      display={persistedDisplay ?? live}
      backgroundResult={backgroundResult}
      executions={group?.executions.map((item, index) => ({
        ...item,
        display: displays[index],
      }))}
    />
  );
}
