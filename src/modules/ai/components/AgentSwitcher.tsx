/**
 * 本文件实现会话级 Agent 选择器。
 * 空白草稿允许选择固定主 Agent 或 Custom Agent，首次发送后只展示冻结身份。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/menu/dropdown-menu";
import { Button } from "@/components/controls/button";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  AbsoluteIcon,
  ArrowDown01Icon,
  CodeIcon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  Settings01Icon,
  ShieldUserIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentIconId,
  agentDisplayDescription,
  agentDisplayName,
  findAgent,
  MAIN_AGENT,
  CHANNEL_AGENT_ID,
} from "@/modules/ai/lib/agents";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useChatStore } from "@/modules/ai/store/chatStore";

const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  spark: SparklesIcon,
};

/** Agent 选择器；持久化会话只显示身份，会话中不允许切换智能体身份。 */
export function AgentSwitcher() {
  const { t } = useTranslation("aiAgents");
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const session = useChatStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId),
  );
  const definitions = useAgentsStore((state) => state.agents);
  const draftAgentId = useAgentsStore((state) => state.draftAgentId);
  const setDraftAgentId = useAgentsStore((state) => state.setDraftAgentId);
  const draftAgent = findAgent(definitions, draftAgentId);
  const isDraft = activeSessionId !== null && session === undefined;
  const sessionAgent = definitions.find(
    (agent) => agent.id === session?.agentId,
  );
  const active = isDraft
    ? draftAgent
    : {
        id: session?.agentId ?? MAIN_AGENT.id,
        name: sessionAgent?.name ?? session?.agentName ?? MAIN_AGENT.name,
        icon: sessionAgent?.icon ?? session?.agentIcon ?? MAIN_AGENT.icon,
      };
  const ActiveIcon = ICONS[active.icon] ?? SparklesIcon;
  const triggerContent = (
    <>
      <HugeiconsIcon icon={ActiveIcon} size={11} strokeWidth={1.75} />
      <span className="max-w-[7rem] truncate">{agentDisplayName(active)}</span>
      {isDraft ? (
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={10}
          strokeWidth={2}
          className="opacity-70"
        />
      ) : null}
    </>
  );

  if (!isDraft) {
    return (
      <span
        className="flex h-6 items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 text-[10.5px] text-muted-foreground"
        title={t("trigger.locked", { name: active.name })}
      >
        {triggerContent}
      </span>
    );
  }

  const agents = definitions.filter((agent) => agent.id !== CHANNEL_AGENT_ID);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          className="flex items-center border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
          title={t("trigger.title", { name: agentDisplayName(active) })}
        >
          {triggerContent}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
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

export { ICONS as AGENT_ICONS };
