/**
 * 本文件呈现内置和自定义智能体、工具权限及提示片段设置。
 * Custom Agent 删除会级联删除其跨 Workspace 会话，运行中会话由后端拒绝删除。
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/controls/alert-dialog";
import { Button } from "@/components/controls/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/controls/dialog";
import { Input } from "@/components/controls/input";
import { Textarea } from "@/components/controls/textarea";
import { cn } from "@/lib/utils";
import { AGENT_ICONS } from "@/modules/ai/components/AgentSwitcher";
import {
  type Agent,
  type AgentIconId,
  agentDisplayDescription,
  agentDisplayName,
  MAIN_AGENT,
  builtinAgent,
  CHANNEL_AGENT_ID,
  parseWorkspaceFiles,
} from "@/modules/ai/lib/agents";
import {
  AGENT_TOOL_GROUPS,
  availableAgentTools,
  setAgentToolEnabled,
} from "@/modules/ai/lib/agentTools";
import { composeAgentPromptSections } from "@/modules/ai/lib/prompt";
import SUBAGENT_PROMPT from "@/modules/ai/prompts/subagent";
import { listSessions } from "@/modules/ai/lib/sessions";
import {
  isValidHandle,
  normalizeHandle,
  type Snippet,
} from "@/modules/ai/lib/snippets";
import { newAgentId, useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  newSnippetId,
  useSnippetsStore,
} from "@/modules/ai/store/snippetsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setCustomInstructions } from "@/modules/settings/store";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FormField } from "@/components/layout/FormField";
import { PageHeader, SectionHeading } from "@/components/layout/PageHeader";

const ICON_OPTIONS: AgentIconId[] = [
  "coder",
  "architect",
  "reviewer",
  "security",
  "designer",
  "spark",
];

/** 内置与自定义智能体、工具权限及复用片段设置区域。 */
export function AgentsSection() {
  const { t } = useTranslation();
  const customInstructions = usePreferencesStore((s) => s.customInstructions);
  const agents = useAgentsStore((s) => s.agents);
  const upsertAgent = useAgentsStore((s) => s.upsert);
  const removeAgent = useAgentsStore((s) => s.remove);
  const hydrateAgents = useAgentsStore((s) => s.hydrate);

  const snippets = useSnippetsStore((s) => s.snippets);
  const upsertSnippet = useSnippetsStore((s) => s.upsert);
  const removeSnippet = useSnippetsStore((s) => s.remove);
  const hydrateSnippets = useSnippetsStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateAgents();
    void hydrateSnippets();
  }, [hydrateAgents, hydrateSnippets]);

  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<{
    agent: Agent;
    sessionCount: number;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const requestAgentDeletion = async (agent: Agent) => {
    try {
      const sessions = await listSessions();
      setDeletingAgent({
        agent,
        sessionCount: sessions.filter((session) => session.agentId === agent.id)
          .length,
      });
    } catch {
      toast.error(t("agents.delete.countFailed"));
    }
  };

  const confirmAgentDeletion = async () => {
    if (!deletingAgent || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await removeAgent(deletingAgent.agent.id);
      setDeletingAgent(null);
    } catch (error) {
      toast.error(
        String(error).includes("CUSTOM_AGENT_SESSIONS_RUNNING")
          ? t("agents.delete.running")
          : t("agents.delete.failed"),
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-section">
      <PageHeader
        title={t("agents.header.title")}
        description={t("agents.header.description")}
      />

      <CustomInstructionsBlock value={customInstructions} />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionHeading>{t("agents.list.label")}</SectionHeading>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setEditingAgent({
                id: newAgentId(),
                name: t("agents.list.newAgentName"),
                description: "",
                instructions: MAIN_AGENT.instructions,
                workspaceFiles: [...MAIN_AGENT.workspaceFiles],
                icon: "spark",
                tools: [...MAIN_AGENT.tools],
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            {t("agents.list.newAgent")}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              builtIn={Boolean(builtinAgent(a.id))}
              onEdit={() => setEditingAgent(a)}
              onDelete={
                builtinAgent(a.id) ? null : () => void requestAgentDeletion(a)
              }
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <SectionHeading>{t("agents.snippets.label")}</SectionHeading>
            <span className="text-[11px] text-muted-foreground">
              <Trans
                i18nKey="agents.snippets.description"
                components={{
                  code: <code className="rounded bg-muted/50 px-1 font-mono" />,
                }}
              />
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setEditingSnippet({
                id: newSnippetId(),
                handle: "",
                name: "",
                description: "",
                content: "",
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            {t("agents.snippets.newSnippet")}
          </Button>
        </div>

        {snippets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            <Trans
              i18nKey="agents.snippets.empty"
              components={{ code: <code className="font-mono" /> }}
            />
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snippets.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
              >
                <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  #{s.handle}
                </code>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium">
                    {s.name}
                  </span>
                  {s.description ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {s.description}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setEditingSnippet(s)}
                  title={t("common.edit")}
                >
                  <HugeiconsIcon
                    icon={Edit02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeSnippet(s.id)}
                  title={t("common.delete")}
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AgentEditorDialog
        agent={editingAgent}
        existing={agents}
        onClose={() => setEditingAgent(null)}
        onSave={async (a) => {
          await upsertAgent(a);
          setEditingAgent(null);
        }}
      />
      <SnippetEditorDialog
        snippet={editingSnippet}
        existing={snippets}
        onClose={() => setEditingSnippet(null)}
        onSave={(s) => {
          upsertSnippet(s);
          setEditingSnippet(null);
        }}
      />
      <AlertDialog
        open={deletingAgent !== null}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeletingAgent(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("agents.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingAgent
                ? t("agents.delete.description", {
                    name: deletingAgent.agent.name,
                    count: deletingAgent.sessionCount,
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              onClick={(event) => {
                event.preventDefault();
                void confirmAgentDeletion();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingAgent && deletingAgent.sessionCount > 0
                ? t("agents.delete.confirmWithSessions", {
                    count: deletingAgent.sessionCount,
                  })
                : t("agents.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AgentCard({
  agent,
  builtIn,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  builtIn: boolean;
  onEdit: (() => void) | null;
  onDelete: (() => void) | null;
}) {
  const { t } = useTranslation();
  const Icon = AGENT_ICONS[agent.icon] ?? SparklesIcon;
  return (
    <div className="group relative flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 transition-colors hover:border-border">
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={Icon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
            {agentDisplayName(agent)}
            {builtIn ? (
              <span className="rounded bg-muted/50 px-1 py-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
                {t("agents.list.builtin")}
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
            {agentDisplayDescription(agent)}
          </span>
        </div>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-1">
        <span className="text-[10px] text-muted-foreground">
          {t("agents.list.toolCount", { count: agent.tools.length })}
        </span>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onEdit ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onEdit}
              title={t("common.edit")}
            >
              <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              title={t("common.delete")}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 编辑智能体草稿，字段标签关联控件；取消时不提交配置。 */
export function AgentEditorDialog({
  agent,
  existing,
  onClose,
  onSave,
}: {
  agent: Agent | null;
  existing: Agent[];
  onClose: () => void;
  onSave: (a: Agent) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Agent | null>(agent);
  const [workspaceFiles, setWorkspaceFiles] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const customInstructions = usePreferencesStore(
    (state) => state.customInstructions,
  );
  useEffect(() => {
    setDraft(agent);
    setWorkspaceFiles(agent?.workspaceFiles.join(", ") ?? "");
    setSaveError(false);
  }, [agent]);
  if (!draft) return null;

  const defaults = builtinAgent(draft.id);
  const isNew = !existing.some((a) => a.id === draft.id);
  let parsedFiles: string[] = [];
  let invalidFiles = false;
  try {
    parsedFiles = parseWorkspaceFiles(workspaceFiles);
  } catch {
    invalidFiles = true;
  }
  const canSave = draft.name.trim().length > 0 && !invalidFiles && !saving;
  const availableTools = availableAgentTools(draft.id === CHANNEL_AGENT_ID);
  const sections = composeAgentPromptSections({
    environment: t("agents.prompt.environmentRuntime"),
    workspace: [t("agents.prompt.workspaceRuntime")],
    agent: draft,
    customInstructions,
  });
  const save = async () => {
    setSaving(true);
    setSaveError(false);
    try {
      await onSave({ ...draft, workspaceFiles: parsedFiles });
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isNew
              ? t("agents.agentDialog.newTitle")
              : t("agents.agentDialog.editTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          <fieldset
            disabled={saving || Boolean(defaults)}
            className="flex flex-col gap-3"
          >
            <div className="flex gap-2">
              <FormField label={t("agents.agentDialog.icon")}>
                <div className="flex flex-wrap gap-1">
                  {ICON_OPTIONS.map((id) => {
                    const Icon = AGENT_ICONS[id] ?? SparklesIcon;
                    const active = draft.icon === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setDraft({ ...draft, icon: id })}
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md border transition-colors",
                          active
                            ? "border-foreground/40 bg-interactive-active"
                            : "border-border/60 hover:bg-interactive-hover",
                        )}
                      >
                        <HugeiconsIcon
                          icon={Icon}
                          size={13}
                          strokeWidth={1.75}
                        />
                      </button>
                    );
                  })}
                </div>
              </FormField>
              <FormField
                label={t("agents.agentDialog.name")}
                htmlFor="agent-name"
                className="flex-1"
              >
                <Input
                  id="agent-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("agents.agentDialog.namePlaceholder")}
                />
              </FormField>
            </div>
            <FormField
              label={t("agents.agentDialog.description")}
              htmlFor="agent-description"
            >
              <Input
                id="agent-description"
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                placeholder={t("agents.agentDialog.descriptionPlaceholder")}
              />
            </FormField>
          </fieldset>
          <SectionHeading>{t("agents.prompt.title")}</SectionHeading>
          <p className="text-muted-foreground">
            {t("agents.prompt.description")}
          </p>
          {sections.map((section) => (
            <section key={section.kind} className="flex flex-col gap-2">
              <SectionHeading>
                {t(`agents.prompt.${section.kind}`)}
              </SectionHeading>
              {section.kind === "agent" ? (
                <>
                  {section.content && (
                    <code>{section.content.split("\n", 1)[0]}</code>
                  )}
                  <FormField
                    label={t("agents.agentDialog.instructions")}
                    htmlFor="agent-instructions"
                  >
                    <Textarea
                      id="agent-instructions"
                      value={draft.instructions}
                      disabled={saving}
                      onChange={(e) =>
                        setDraft({ ...draft, instructions: e.target.value })
                      }
                      className="min-h-40 resize-y font-mono"
                    />
                  </FormField>
                  {defaults && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          instructions: defaults.instructions,
                        })
                      }
                    >
                      {t("agents.prompt.resetInstructions")}
                    </Button>
                  )}
                </>
              ) : section.kind === "workspace" ? (
                <>
                  <FormField
                    label={t("agents.prompt.files")}
                    htmlFor="agent-workspace-files"
                  >
                    <Input
                      id="agent-workspace-files"
                      value={workspaceFiles}
                      disabled={saving}
                      aria-invalid={invalidFiles}
                      onChange={(e) => setWorkspaceFiles(e.target.value)}
                    />
                  </FormField>
                  <p className="text-muted-foreground">{section.content}</p>
                  {invalidFiles && (
                    <p role="alert" className="text-destructive">
                      {t("agents.prompt.invalidFiles")}
                    </p>
                  )}
                </>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono">
                  {section.content || t("agents.prompt.empty")}
                </pre>
              )}
            </section>
          ))}
          <details>
            <summary className="cursor-pointer">
              {t("agents.prompt.subagent")}
            </summary>
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono">
              {SUBAGENT_PROMPT}
            </pre>
          </details>
          <div className="flex flex-col gap-1.5">
            <SectionHeading>{t("agents.agentDialog.tools")}</SectionHeading>
            <span className="text-[11px] leading-4 text-muted-foreground">
              {t("agents.agentDialog.toolsDescription")}
            </span>
            <div className="divide-y divide-border/40 rounded-lg border border-border/60 bg-card/60">
              {AGENT_TOOL_GROUPS.map((group) => (
                <section key={group.id} className="flex flex-col">
                  <div className="px-3 py-2">
                    <SectionHeading>
                      {t(`agents.tools.${group.id}.label`)}
                    </SectionHeading>
                  </div>
                  {group.tools.map((id) => {
                    const unavailable = !availableTools.includes(id);
                    return (
                      <label
                        key={id}
                        htmlFor={`agent-tool-${id}`}
                        className="flex items-start gap-2 px-3 py-2 hover:bg-interactive-hover"
                      >
                        <Checkbox
                          id={`agent-tool-${id}`}
                          checked={draft.tools.includes(id)}
                          disabled={saving || unavailable}
                          onCheckedChange={(value) =>
                            setDraft({
                              ...draft,
                              tools: setAgentToolEnabled(
                                draft.tools,
                                id,
                                value === true,
                              ),
                            })
                          }
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <code>{id}</code>
                          <span className="text-muted-foreground">
                            {t(`agents.toolDescriptions.${id}`)}
                          </span>
                          {unavailable && (
                            <span className="text-muted-foreground">
                              {t("agents.agentDialog.unavailable")}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </section>
              ))}
            </div>
            <span className="text-[11px] leading-4 text-muted-foreground">
              {t("agents.agentDialog.nextTurn")}
            </span>
            {defaults && (
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() =>
                  setDraft({ ...draft, tools: [...defaults.tools] })
                }
              >
                {t("agents.agentDialog.resetTools")}
              </Button>
            )}
          </div>
        </div>
        {saveError && (
          <p role="alert" className="text-destructive">
            {t("agents.agentDialog.saveFailed")}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 编辑片段草稿，保留标识校验与显式保存行为。 */
function SnippetEditorDialog({
  snippet,
  existing,
  onClose,
  onSave,
}: {
  snippet: Snippet | null;
  existing: Snippet[];
  onClose: () => void;
  onSave: (s: Snippet) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Snippet | null>(snippet);
  useEffect(() => setDraft(snippet), [snippet]);
  if (!draft) return null;

  const handleErr = !draft.handle
    ? t("agents.snippetDialog.errRequired")
    : !isValidHandle(draft.handle)
      ? t("agents.snippetDialog.errFormat")
      : existing.some((s) => s.id !== draft.id && s.handle === draft.handle)
        ? t("agents.snippetDialog.errInUse")
        : null;
  const canSave =
    !handleErr &&
    draft.name.trim().length > 0 &&
    draft.content.trim().length > 0;

  return (
    <Dialog open={!!snippet} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {existing.some((s) => s.id === draft.id)
              ? t("agents.snippetDialog.editTitle")
              : t("agents.snippetDialog.newTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          <div className="flex gap-2">
            <FormField
              label={t("agents.snippetDialog.handle")}
              htmlFor="snippet-handle"
              className="w-32"
            >
              <div className="relative">
                <span className="absolute top-1/2 left-2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                  #
                </span>
                <Input
                  id="snippet-handle"
                  value={draft.handle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      handle: normalizeHandle(e.target.value),
                    })
                  }
                  placeholder={t("agents.snippetDialog.handlePlaceholder")}
                  className="pl-5 font-mono"
                />
              </div>
              {handleErr ? (
                <span className="text-[10px] text-destructive">
                  {handleErr}
                </span>
              ) : null}
            </FormField>
            <FormField
              label={t("agents.snippetDialog.name")}
              htmlFor="snippet-name"
              className="flex-1"
            >
              <Input
                id="snippet-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("agents.snippetDialog.namePlaceholder")}
              />
            </FormField>
          </div>
          <FormField
            label={t("agents.snippetDialog.description")}
            htmlFor="snippet-description"
          >
            <Input
              id="snippet-description"
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder={t("agents.snippetDialog.descriptionPlaceholder")}
            />
          </FormField>
          <FormField
            label={t("agents.snippetDialog.content")}
            htmlFor="snippet-content"
          >
            <Textarea
              id="snippet-content"
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              placeholder={t("agents.snippetDialog.contentPlaceholder")}
              className="min-h-40 resize-y font-mono leading-relaxed"
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSave} onClick={() => onSave(draft)}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomInstructionsBlock({ value }: { value: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const hadFirstSync = useRef(false);

  useEffect(() => {
    if (!hadFirstSync.current) {
      hadFirstSync.current = true;
      setDraft(value);
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionHeading>{t("agents.customInstructions.label")}</SectionHeading>
        {draft && (
          <Button size="xs" onClick={() => void setCustomInstructions(draft)}>
            {t("common.save")}
          </Button>
        )}
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("agents.customInstructions.placeholder")}
        className="min-h-[100px] resize-y bg-card/60 font-sans leading-relaxed border border-border"
      />
    </div>
  );
}
