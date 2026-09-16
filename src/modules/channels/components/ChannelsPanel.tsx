/** Channel 人工发送入口；面板只持有草稿和历史投影，关闭不会停止投递。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/controls/button";
import { Textarea } from "@/components/controls/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/controls/select";
import {
  sendChannelContent,
  useChannelsView,
  useChannelSelection,
  requestChannels,
} from "@/modules/channels/client";
import { ConnectionStatus } from "@/modules/channels/components/ConnectionStatus";
import { DeliveryCard } from "@/modules/channels/components/DeliveryCard";
import {
  projectDeliveries,
  type DeliveryDisplay,
} from "@/modules/channels/history";
import { projectCommands } from "@/modules/ai/commands/records";
import {
  messageMetadata,
  projectSessionMessages,
} from "@/modules/ai/lib/conversation";
import { readSession } from "@/modules/ai/lib/sessions";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { channelTargetLabel } from "@/modules/channels/types";

type HistoryEntry = {
  id: string;
  timestamp: number;
  text: string;
  role: string;
  delivery?: DeliveryDisplay;
};
type Draft = { text: string; paths: string[] };
const EMPTY_DRAFT: Draft = { text: "", paths: [] };

export function ChannelsPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation("channels");
  const snapshots = useChannelsView((state) => state.snapshots);
  const serviceError = useChannelsView((state) => state.error);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scrollSession = useRef<string | undefined>(undefined);
  const selected = useChannelSelection((state) => state.connectionId);
  const setSelected = (connectionId: string) =>
    useChannelSelection.setState({ connectionId });
  const [selectedSessions, setSelectedSessions] = useState<
    Record<string, string>
  >({});
  const snapshot =
    snapshots.find((item) => item.connection.id === selected) ?? snapshots[0];
  const id = snapshot?.connection.id ?? "";
  const conversation =
    snapshot?.conversations.find(
      (item) => item.sessionId === selectedSessions[id],
    ) ?? snapshot?.conversations[0];
  const sessionId = conversation?.sessionId;
  const draftKey = sessionId ?? "";
  const sessionMeta = useChatStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{
    sessionId: string;
    entries: HistoryEntry[];
  }>();
  const updateDraft = (value: Draft) =>
    setDrafts((current) => ({ ...current, [draftKey]: value }));

  useEffect(() => {
    if (!visible || !sessionId || !sessionMeta) return;
    let active = true;
    void readSession(sessionId)
      .then((session) => {
        if (!active) return;
        const entries: HistoryEntry[] = projectSessionMessages(
          sessionId,
          session.messages,
        )
          .filter((message) => !messageMetadata(message).commandId)
          .map((message) => ({
            id: message.id,
            timestamp: messageMetadata(message).createdAt ?? 0,
            role: message.role,
            text: message.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
          }))
          .filter((entry) => entry.text);
        for (const command of projectCommands(session.messages))
          entries.push({
            id: command.id,
            timestamp: command.timestamp,
            role: "command",
            text: [command.input, command.result?.text]
              .filter(Boolean)
              .join("\n"),
          });
        for (const delivery of projectDeliveries(session.messages)) {
          const reply =
            delivery.source === "agent"
              ? entries.find(
                  (entry) =>
                    entry.id === delivery.afterMessageId &&
                    entry.role === "assistant" &&
                    entry.text === delivery.content.text,
                )
              : undefined;
          if (reply) {
            reply.delivery = delivery;
            continue;
          }
          entries.push({
            id: delivery.id,
            timestamp: delivery.timestamp,
            role: "delivery",
            text: "",
            delivery,
          });
        }
        setHistory({
          sessionId,
          entries: entries.sort((a, b) => a.timestamp - b.timestamp),
        });
      })
      .catch(() => {
        if (active) setError(t("errors.storage"));
      });
    return () => {
      active = false;
    };
  }, [visible, sessionId, sessionMeta, t]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!visible || !element || history?.sessionId !== sessionId) return;
    if (follow.current || scrollSession.current !== sessionId)
      element.scrollTop = element.scrollHeight;
    scrollSession.current = sessionId;
  }, [history, visible, sessionId]);

  const submit = async () => {
    if (!conversation?.canSend || pending) return;
    setPending(true);
    setError("");
    try {
      await sendChannelContent({
        connectionId: id,
        sessionId: conversation.sessionId,
        content: {
          text: draft.text,
          attachments: draft.paths.map((path) => ({
            path,
            presentation: "file",
          })),
        },
      });
      updateDraft(EMPTY_DRAFT);
    } catch {
      setError(t("outbound.sendFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-[12px] dark:bg-sidebar">
      <div className="space-y-2 border-b border-border p-3">
        <Select
          value={id}
          onValueChange={setSelected}
          disabled={pending || !snapshots.length}
        >
          <SelectTrigger aria-label={t("outbound.instance")}>
            <SelectValue placeholder={t("emptyDetail")} />
          </SelectTrigger>
          <SelectContent>
            {snapshots.map((item) => (
              <SelectItem key={item.connection.id} value={item.connection.id}>
                {item.connection.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sessionId ?? ""}
          disabled={pending || !snapshot?.conversations.length}
          onValueChange={(sessionId) =>
            setSelectedSessions((current) => ({ ...current, [id]: sessionId }))
          }
        >
          <SelectTrigger aria-label={t("outbound.conversation")}>
            <SelectValue placeholder={t("outbound.noTarget")} />
          </SelectTrigger>
          <SelectContent>
            {snapshot?.conversations.map((item) => (
              <SelectItem key={item.sessionId} value={item.sessionId}>
                {channelTargetLabel(item.target)} ·{" "}
                {t(`outbound.${item.target.kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(sessionId || snapshot) && (
          <div className="flex items-center gap-3">
            {sessionId && (
              <Button
                onClick={() =>
                  void requestChannels({ action: "open", id, sessionId }).catch(
                    () => setError(t("errors.storage")),
                  )
                }
              >
                {t("outbound.openInAgent")}
              </Button>
            )}
            {snapshot && <ConnectionStatus snapshot={snapshot} />}
          </div>
        )}
        {conversation && !conversation.canSend && (
          <p className="text-muted-foreground">{t("outbound.unavailable")}</p>
        )}
        {snapshot?.issue && (
          <p
            role="alert"
            className={
              snapshot.issue === "delivery-unknown"
                ? "text-amber-600 dark:text-amber-400"
                : "text-destructive"
            }
          >
            {t(`errors.${snapshot.issue}`)}
          </p>
        )}
        <div className="break-all text-muted-foreground">
          {conversation
            ? t("outbound.target", { id: conversation.target.id })
            : t("outbound.noTarget")}
        </div>
      </div>
      <div
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
        }}
        className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {visible &&
          history &&
          history.sessionId === sessionId &&
          history.entries.map((entry) =>
            entry.delivery && entry.role === "delivery" ? (
              <DeliveryCard key={entry.id} entry={entry.delivery} />
            ) : (
              <div key={entry.id} className="rounded-md bg-secondary p-3">
                <div className="mb-1 text-muted-foreground">
                  {t(`outbound.roles.${entry.role}`)}
                </div>
                <p className="whitespace-pre-wrap break-words">{entry.text}</p>
                {entry.delivery && (
                  <DeliveryCard entry={entry.delivery} compact />
                )}
              </div>
            ),
          )}
      </div>
      <div className="space-y-2 border-t border-border p-3">
        {(error || serviceError) && (
          <p role="alert" className="text-destructive">
            {error || t(`errors.${serviceError}`)}
          </p>
        )}
        <Textarea
          value={draft.text}
          disabled={pending || !sessionId}
          maxLength={32000}
          rows={3}
          aria-label={t("outbound.text")}
          placeholder={t("outbound.text")}
          onChange={(event) =>
            updateDraft({ ...draft, text: event.target.value })
          }
        />
        {draft.paths.length > 16 && (
          <p role="alert" className="text-destructive">
            {t("outbound.tooManyFiles")}
          </p>
        )}
        {draft.paths.map((path) => (
          <div key={path} className="flex items-center gap-1">
            <span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
              {path}
            </span>
            <Button
              size="xs"
              disabled={pending}
              onClick={() =>
                updateDraft({
                  ...draft,
                  paths: draft.paths.filter((item) => item !== path),
                })
              }
            >
              {t("outbound.remove")}
            </Button>
          </div>
        ))}
        <div className="flex justify-between gap-2">
          <Button
            disabled={pending || !sessionId}
            onClick={() => {
              void open({ multiple: true, directory: false })
                .then((paths) => {
                  if (paths)
                    setDrafts((current) => {
                      const previous = current[draftKey] ?? EMPTY_DRAFT;
                      const next = [...new Set([...previous.paths, ...paths])];
                      return {
                        ...current,
                        [draftKey]: { ...previous, paths: next },
                      };
                    });
                })
                .catch(() => setError(t("outbound.fileFailed")));
            }}
          >
            {t("outbound.addFiles")}
          </Button>
          <Button
            variant="default"
            disabled={
              pending ||
              draft.paths.length > 16 ||
              !conversation?.canSend ||
              snapshot.status !== "online" ||
              (!draft.text.trim() && !draft.paths.length)
            }
            onClick={() => void submit()}
          >
            {t("outbound.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}
