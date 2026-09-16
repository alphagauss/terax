/** Channel 人工发送入口；面板只持有草稿和历史投影，关闭不会停止投递。 */
import { useEffect, useState } from "react";
import type { Chat, UIMessage } from "@ai-sdk/react";
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
import { ChannelConversation } from "@/modules/channels/components/ChannelConversation";
import { loadChat } from "@/modules/ai/store/chatRuntime";
import {
  chats,
  retainSessionView,
  releaseUnusedChats,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { channelTargetLabel } from "@/modules/channels/types";

type Draft = { text: string; paths: string[] };
const EMPTY_DRAFT: Draft = { text: "", paths: [] };

export function ChannelsPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation("channels");
  const snapshots = useChannelsView((state) => state.snapshots);
  const serviceError = useChannelsView((state) => state.error);
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
  const [chat, setChat] = useState<Chat<UIMessage>>();
  const [historyError, setHistoryError] = useState(false);
  // 注册表失效时立即停止展示旧实例，随后复用现有冷加载入口。
  const registered = useChatStore(() =>
    sessionId ? chats.get(sessionId) : undefined,
  );
  const viewing = visible && sessionMeta ? sessionId : undefined;
  useEffect(
    () => (viewing ? retainSessionView(viewing) : undefined),
    [viewing],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文件版本或注册实例失效时需要重新加载。
  useEffect(() => {
    setHistoryError(false);
    if (!viewing) return;
    let active = true;
    void loadChat(viewing).then(
      (loaded) => {
        if (active) setChat(loaded);
        else releaseUnusedChats();
      },
      () => {
        if (active) setHistoryError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [viewing, sessionMeta?.fingerprint, registered]);
  const updateDraft = (value: Draft) =>
    setDrafts((current) => ({ ...current, [draftKey]: value }));

  const submit = async () => {
    if (!conversation || snapshot.status !== "online" || pending) return;
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
        {conversation && snapshot.status !== "online" && (
          <p className="text-muted-foreground">{t("outbound.unavailable")}</p>
        )}
        {snapshot?.issue &&
          snapshot.issue !== "delivery" &&
          snapshot.issue !== "delivery-unknown" && (
            <p role="alert" className="text-destructive">
              {t(`errors.${snapshot.issue}`)}
            </p>
          )}
        <div className="break-all text-muted-foreground">
          {conversation
            ? t("outbound.target", { id: conversation.target.id })
            : t("outbound.noTarget")}
        </div>
      </div>
      {viewing && chat?.id === viewing && chat === registered ? (
        <ChannelConversation
          key={viewing}
          chat={chat}
          sessionId={viewing}
          connectionId={id}
          canRetry={snapshot?.status === "online"}
          onError={setError}
        />
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      <div className="space-y-2 border-t border-border p-3">
        {(error || serviceError || historyError) && (
          <p role="alert" className="text-destructive">
            {error ||
              (historyError
                ? t("errors.storage")
                : t(`errors.${serviceError}`))}
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
              !conversation ||
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
