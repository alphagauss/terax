/**
 * 本文件实现可复用的 Python 解释器搜索选择对话框。
 * 列表仅在打开时按需发现；本地环境允许使用系统文件选择器作为未发现环境的兜底。
 */

import { Button } from "@/components/controls/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  listPythonInterpreters,
  type PythonInterpreter,
  probePythonInterpreter,
} from "@/modules/python/native";
import { WorkbenchPageDialog } from "@/modules/workbench/WorkbenchPageOverlays";
import type { WorkspaceEnv } from "@/modules/workspace";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  root: string | null;
  workspace: WorkspaceEnv;
  selectedPath?: string | null;
  title?: string;
  onSelect: (interpreter: PythonInterpreter) => Promise<void> | void;
  /** 页内模式继承调用方工作页的浮层作用域，默认保留全窗口行为。 */
  scope?: "window" | "page";
};

type InterpreterGroup = "workspace" | "environments" | "system";

function groupFor(interpreter: PythonInterpreter): InterpreterGroup {
  if (interpreter.kind === "workspaceVirtualEnv") return "workspace";
  if (interpreter.kind === "system") return "system";
  return "environments";
}

/** 按需发现、搜索并选择一个 Python 解释器。 */
export function PythonInterpreterDialog({
  open,
  onOpenChange,
  root,
  workspace,
  selectedPath,
  title,
  onSelect,
  scope = "window",
}: Props) {
  const { t } = useTranslation("python");
  const [interpreters, setInterpreters] = useState<PythonInterpreter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 计数器只作为显式重试信号，不参与请求参数。
    void refreshNonce;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInterpreters([]);
    void listPythonInterpreters(root, workspace)
      .then((items) => {
        if (!cancelled) setInterpreters(items);
      })
      .catch((reason) => {
        if (!cancelled) {
          console.warn("[python] interpreter discovery failed", reason);
          setInterpreters([]);
          setError(t("discoveryFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshNonce, root, t, workspace]);

  const groups = useMemo(() => {
    const grouped: Record<InterpreterGroup, PythonInterpreter[]> = {
      workspace: [],
      environments: [],
      system: [],
    };
    for (const interpreter of interpreters) {
      grouped[groupFor(interpreter)].push(interpreter);
    }
    return grouped;
  }, [interpreters]);

  /** 保存已完成探测的解释器，持久化失败时保持对话框打开。 */
  const commitSelection = async (interpreter: PythonInterpreter) => {
    try {
      await onSelect(interpreter);
      onOpenChange(false);
    } catch (reason) {
      console.warn("[python] interpreter selection failed", reason);
      setError(t("selectionFailed"));
    }
  };

  /** 提交发现列表中的解释器，并在调用方完成持久化后关闭对话框。 */
  const choose = async (interpreter: PythonInterpreter) => {
    if (selecting) return;
    setSelecting(true);
    setError(null);
    try {
      await commitSelection(interpreter);
    } finally {
      setSelecting(false);
    }
  };

  /** 在 Local Workspace 中通过系统文件选择器探测列表外解释器。 */
  const browse = async () => {
    if (workspace.kind !== "local" || selecting) return;
    // 原生选择器等待期间也属于同一次选择，防止关闭后旧结果继续提交。
    setSelecting(true);
    setError(null);
    let errorKey: "browseFailed" | "probeFailed" = "browseFailed";
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: t("browseTitle"),
      });
      if (!selected || Array.isArray(selected)) return;
      errorKey = "probeFailed";
      const interpreter = await probePythonInterpreter(selected, workspace);
      await commitSelection(interpreter);
    } catch (reason) {
      console.warn(`[python] interpreter ${errorKey}`, reason);
      setError(t(errorKey));
    } finally {
      setSelecting(false);
    }
  };

  const Dialog = scope === "page" ? WorkbenchPageDialog : CommandDialog;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !selecting && onOpenChange(next)}
      title={title ?? t("title")}
      {...(scope === "window" ? { description: t("description") } : {})}
      className={
        scope === "page"
          ? "w-[42rem]"
          : "w-[min(42rem,calc(100vw-2rem))] max-w-none"
      }
    >
      <Command className={scope === "page" ? "rounded-none" : "rounded-4xl"}>
        <CommandInput placeholder={t("searchPlaceholder")} disabled={loading} />
        <CommandList className="max-h-88">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Spinner className="size-3.5" aria-hidden="true" />
              {t("loading")}
            </div>
          ) : null}
          {!loading && !error ? (
            <CommandEmpty>{t("empty")}</CommandEmpty>
          ) : null}
          {(["workspace", "environments", "system"] as const).map((group) =>
            groups[group].length > 0 ? (
              <CommandGroup key={group} heading={t(`groups.${group}`)}>
                {groups[group].map((interpreter) => (
                  <CommandItem
                    key={`${interpreter.source}:${interpreter.path}`}
                    value={`${interpreter.name} ${interpreter.version} ${interpreter.path}`}
                    data-checked={interpreter.path === selectedPath}
                    disabled={loading || selecting}
                    onSelect={() => void choose(interpreter)}
                    className="items-start"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[12.5px]">
                          {interpreter.name}
                        </span>
                        <span className="shrink-0 text-[10.5px] font-normal text-muted-foreground">
                          {t("version", { version: interpreter.version })}
                        </span>
                      </div>
                      <div className="truncate text-[10.5px] font-normal text-muted-foreground">
                        {interpreter.path}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null,
          )}
          {error ? (
            <div className="px-4 py-3 text-[11px] text-destructive">
              {error}
            </div>
          ) : null}
          <CommandSeparator />
          <div
            className={cn(
              "flex items-center justify-end gap-2 px-3 py-2",
              workspace.kind !== "local" && "justify-center",
            )}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || selecting}
              onClick={() => setRefreshNonce((value) => value + 1)}
            >
              {t("refresh")}
            </Button>
            {workspace.kind === "local" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={selecting}
                onClick={() => void browse()}
              >
                {t("browse")}
              </Button>
            ) : null}
          </div>
        </CommandList>
      </Command>
    </Dialog>
  );
}
