/** 从原生进程表展示存活资源；只读轮询随视图可见性启停，不影响进程生命周期。 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/controls/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { reportError } from "@/lib/errors";
import {
  useChatDisplayActive,
  useChatDisplayStore,
} from "@/modules/ai/hooks/chatDisplay";
import { native, type ShellProcessInfo } from "@/modules/ai/lib/native";
import { redactSensitive } from "@/modules/ai/lib/redact";
import {
  clearIdleSessionProcesses,
  useChatStore,
} from "@/modules/ai/store/chatStore";

type ProcessView = Pick<
  ShellProcessInfo,
  "process_id" | "command" | "execution_id" | "task_id"
>;

const Processes = createContext<readonly ProcessView[] | undefined>(undefined);

/** 每个聊天视图只读取一次进程列表，卡片共用同一快照。 */
export function SessionProcessesProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  const active = useChatDisplayActive();
  const { t } = useTranslation("ai");
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    processes?: ProcessView[];
    failed?: boolean;
  }>();
  const [clearing, setClearing] = useState(false);
  const [revision, setRevision] = useState(0);
  const locked = useChatDisplayStore(useChatStore, (state) =>
    Boolean(state.runLockSessionIds[sessionId]),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: 运行锁变化及清理结束需要立即重读原生状态。
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const processes = (await native.shellList(sessionId)).map(
          ({ process_id, command, execution_id, task_id }) => ({
            process_id,
            command,
            execution_id,
            task_id,
          }),
        );
        if (!disposed)
          setSnapshot((previous) =>
            previous?.sessionId === sessionId &&
            JSON.stringify(previous.processes) === JSON.stringify(processes)
              ? previous
              : { sessionId, processes },
          );
      } catch {
        if (!disposed) setSnapshot({ sessionId, failed: true });
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 3000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, sessionId, revision, locked]);
  const current = snapshot?.sessionId === sessionId ? snapshot : undefined;
  const processes = current?.processes;
  const clear = async () => {
    setClearing(true);
    try {
      await clearIdleSessionProcesses(sessionId);
    } catch (error) {
      reportError(t("chat.processes.cleanupFailed"), { error });
    } finally {
      setClearing(false);
      setRevision((value) => value + 1);
    }
  };
  return (
    <Processes.Provider value={processes}>
      {children}
      {current?.failed && (
        <p className="text-[11px] text-muted-foreground">
          {t("chat.processes.unavailable")}
        </p>
      )}
      {!!processes?.length && (
        <Collapsible className="text-[11px] text-muted-foreground">
          <CollapsibleTrigger
            data-chat-scroll-preserve
            className="hover:text-foreground"
          >
            {t("chat.processes.running", { count: processes.length })}
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            {processes.map((process) => (
              <div key={process.process_id} className="min-w-0">
                <div className="truncate font-mono text-foreground">
                  {redactSensitive(process.command)}
                </div>
                <div className="break-all">
                  {process.task_id
                    ? t("chat.processes.task", { taskId: process.task_id })
                    : t("chat.processes.main")}{" "}
                  · {process.process_id}
                </div>
              </div>
            ))}
            <Button
              variant="ghost-destructive"
              size="sm"
              disabled={locked || clearing}
              onClick={() => void clear()}
            >
              {t(
                clearing
                  ? "chat.processes.cleaning"
                  : "chat.processes.clearAll",
              )}
            </Button>
            {locked && !clearing && <p>{t("chat.processes.stopFirst")}</p>}
          </CollapsibleContent>
        </Collapsible>
      )}
    </Processes.Provider>
  );
}

/** 执行结果保持不变，存活进程数单独反映当前资源状态。 */
export function ExecutionProcesses({ runId }: { runId?: string }) {
  const processes = useContext(Processes);
  const { t } = useTranslation("ai");
  if (!runId || !processes) return null;
  const count = processes.filter(
    (process) => process.execution_id === runId,
  ).length;
  return count > 0 ? (
    <span className="text-[11px] text-muted-foreground">
      {t("chat.processes.running", { count })}
    </span>
  ) : null;
}
