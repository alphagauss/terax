/**
 * 本文件实现草稿 Agent 选择器和会话只读身份。
 * 空白草稿允许选择固定主 Agent 或 Custom Agent，首次发送后只展示冻结身份。
 */

import { Button } from "@/components/controls/button";
import { Hint } from "@/components/controls/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { cn } from "@/lib/utils";
import { parseExternalAgentBinding } from "@/modules/ai/external-agents/runtime";
import {
  type AgentIconId,
  agentDisplayDescription,
  agentDisplayName,
  CHANNEL_AGENT_ID,
  findAgent,
  MAIN_AGENT,
} from "@/modules/ai/lib/agents";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { sessionMetadata, useChatStore } from "@/modules/ai/store/chatStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import AbsoluteIcon from "@hugeicons/core-free-icons/AbsoluteIcon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import PaintBrush04Icon from "@hugeicons/core-free-icons/PaintBrush04Icon";
import PencilEdit02Icon from "@hugeicons/core-free-icons/PencilEdit02Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import ShieldUserIcon from "@hugeicons/core-free-icons/ShieldUserIcon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  spark: SparklesIcon,
};

/** 空白草稿的 Agent 选择器；会话开始后不再渲染。 */
export function AgentPicker() {
  const { t } = useTranslation("aiAgents");
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const draftSessionId = useChatStore((state) => state.draftSessionId);
  const draftExternalAgentId = useChatStore(
    (state) => state.draftExternalAgentId,
  );
  const sessionExists = useChatStore((state) =>
    state.sessions.some((item) => item.id === state.activeSessionId),
  );
  const definitions = useAgentsStore((state) => state.agents);
  const draftAgentId = useAgentsStore((state) => state.draftAgentId);
  const setDraftAgentId = useAgentsStore((state) => state.setDraftAgentId);
  const usesExternalAgent = Boolean(
    parseExternalAgentBinding(
      activeSessionId ? sessionMetadata.get(activeSessionId) : undefined,
    ) ?? (activeSessionId === draftSessionId ? draftExternalAgentId : null),
  );
  const isDraft = activeSessionId !== null && !sessionExists;

  if (!isDraft || usesExternalAgent) return null;

  const active = findAgent(definitions, draftAgentId);
  const activeName = agentDisplayName(active);
  const ActiveIcon = ICONS[active.icon] ?? SparklesIcon;
  const agents = definitions.filter((agent) => agent.id !== CHANNEL_AGENT_ID);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("trigger.title", { name: activeName })}
          size="sm"
          variant="ghost"
          className="max-w-full"
        >
          <HugeiconsIcon icon={ActiveIcon} size={13} strokeWidth={1.75} />
          <span className="truncate">{activeName}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-60">
        {agents.map((agent, index) => {
          const Icon = ICONS[agent.icon] ?? SparklesIcon;
          return (
            <Fragment key={agent.id}>
              {index === 1 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                onSelect={() => setDraftAgentId(agent.id)}
                className={cn(
                  "flex items-start gap-2 pr-2 text-[12px]",
                  agent.id === draftAgentId && "bg-interactive-active",
                )}
              >
                <HugeiconsIcon
                  icon={Icon}
                  size={13}
                  strokeWidth={1.75}
                  className="mt-0.5 text-muted-foreground"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{agentDisplayName(agent)}</span>
                  <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                    {agentDisplayDescription(agent)}
                  </span>
                </span>
                {agent.id === draftAgentId ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={12}
                    strokeWidth={2}
                    className="mt-0.5 shrink-0 text-foreground"
                  />
                ) : null}
              </DropdownMenuItem>
            </Fragment>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("agents")}
          className="gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          {t("manageAgents")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 已开始会话的只读 Agent 身份，不提供切换入口。 */
export function SessionAgentIdentity({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { t } = useTranslation("aiAgents");
  const session = useChatStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const definitions = useAgentsStore((state) => state.agents);
  if (
    !session ||
    parseExternalAgentBinding(
      sessionId ? sessionMetadata.get(sessionId) : undefined,
    )
  )
    return null;

  const configured = definitions.find((agent) => agent.id === session.agentId);
  const active = {
    id: session.agentId ?? MAIN_AGENT.id,
    name: configured?.name ?? session.agentName ?? MAIN_AGENT.name,
    icon: configured?.icon ?? session.agentIcon ?? MAIN_AGENT.icon,
  };
  const activeName = agentDisplayName(active);
  const ActiveIcon = ICONS[active.icon] ?? SparklesIcon;

  return (
    <Hint content={t("trigger.locked", { name: activeName })}>
      <span
        role="img"
        aria-label={t("trigger.locked", { name: activeName })}
        className="flex h-6 min-w-0 max-w-32 shrink items-center gap-1 px-1 text-[10.5px] text-muted-foreground"
      >
        <HugeiconsIcon
          icon={ActiveIcon}
          size={11}
          strokeWidth={1.75}
          className="shrink-0"
        />
        <span className="truncate">{activeName}</span>
      </span>
    </Hint>
  );
}

export { ICONS as AGENT_ICONS };
