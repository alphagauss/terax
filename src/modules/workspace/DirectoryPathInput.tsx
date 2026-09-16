/** WSL 与 SSH 共用的一级目录补全，输入名称只过滤当前层，提交由调用者拥有。 */
import { Input } from "@/components/controls/input";
import { useRemoteRuntimeStore } from "@/modules/remote/runtimeStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Popover } from "radix-ui";
import {
  type ComponentProps,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { directoryQuery } from "./directoryPath";
import { useWorkspaceEnvStore } from "./env";

type Props = Omit<ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
};

/** 焦点保留在输入框，候选选择只补全名称，不触发表单提交或读取下一层。 */
export function DirectoryPathInput({
  value,
  onValueChange,
  className,
  ...props
}: Props) {
  const { t } = useTranslation("spaces");
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const connection = useRemoteRuntimeStore((state) =>
    state.snapshot.phase === "connected"
      ? state.snapshot.epoch
      : state.snapshot.phase,
  );
  const showHidden = usePreferencesStore((state) => state.showHidden);
  const [suggesting, setSuggesting] = useState(false);
  const [active, setActive] = useState<{ key: string; name: string } | null>(
    null,
  );
  const [result, setResult] = useState<{
    key: string;
    names: string[];
    error?: string;
  } | null>(null);
  const query = directoryQuery(value);
  const parent = query?.parent ?? "";
  const prefix = query?.prefix ?? "";
  const ready = workspace.kind !== "ssh" || typeof connection === "number";
  const key = JSON.stringify([workspace, connection, parent]);
  const open = suggesting && !!parent;
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !ready || result?.key === key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoke<string[]>("list_subdirs", {
        path: parent,
        workspace,
        showHidden: true,
      }).then(
        (names) => {
          if (!cancelled) setResult({ key, names });
        },
        (error) => {
          if (!cancelled) setResult({ key, names: [], error: String(error) });
        },
      );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, ready, key, parent, workspace, result?.key]);

  const current = ready && result?.key === key ? result : null;
  const names = useMemo(
    () =>
      (current?.names ?? []).filter(
        (name) =>
          name.startsWith(prefix) &&
          (showHidden || prefix.startsWith(".") || !name.startsWith(".")),
      ),
    [current, prefix, showHidden],
  );
  const virtualizer = useVirtualizer({
    count: names.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 4,
  });
  const selected = active?.key === key ? names.indexOf(active.name) : -1;
  // 弹层重新挂载后再滚动，避免方向键打开列表时滚动容器尚不存在。
  useEffect(() => {
    if (!open || !names.length) return;
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(Math.max(selected, 0), { align: "auto" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, names, selected, virtualizer]);
  const choose = (name: string) => {
    onValueChange(parent + name);
    setSuggesting(false);
    setActive(null);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setSuggesting(false);
      }}
    >
      <Popover.Anchor asChild>
        <Input
          {...props}
          className={className}
          value={value}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-activedescendant={
            open && selected >= 0 ? `${id}-${selected}` : undefined
          }
          onFocus={() => {
            setSuggesting(true);
            if (result?.error) setResult(null);
          }}
          onBlur={() => {
            setSuggesting(false);
            setActive(null);
          }}
          onChange={(event) => {
            onValueChange(event.target.value);
            setSuggesting(true);
            setActive(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setSuggesting(false);
              setActive(null);
            } else if (
              (event.key === "ArrowDown" || event.key === "ArrowUp") &&
              parent
            ) {
              event.preventDefault();
              setSuggesting(true);
              if (names.length) {
                const next =
                  event.key === "ArrowDown"
                    ? (selected + 1) % names.length
                    : selected <= 0
                      ? names.length - 1
                      : selected - 1;
                setActive({ key, name: names[next] });
              }
            } else if (event.key === "Enter" && open && selected >= 0) {
              event.preventDefault();
              choose(names[selected]);
            }
          }}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[var(--radix-popover-trigger-width)] min-w-48 rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setSuggesting(false);
            setActive(null);
          }}
          onInteractOutside={(event) => {
            if (
              event.target instanceof HTMLInputElement &&
              event.target.getAttribute("aria-controls") === id
            )
              event.preventDefault();
          }}
        >
          <div
            id={id}
            role="listbox"
            aria-label={t("directorySuggestions")}
            ref={scrollRef}
            className="max-h-56 overflow-auto"
            style={{
              height: names.length
                ? Math.min(names.length * 28, 224)
                : undefined,
            }}
          >
            {names.length ? (
              <div
                className="relative"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((row) => (
                  <button
                    type="button"
                    tabIndex={-1}
                    key={names[row.index]}
                    id={`${id}-${row.index}`}
                    role="option"
                    aria-selected={selected === row.index}
                    className={`absolute left-0 flex h-7 w-full cursor-default items-center truncate rounded-sm px-2 ${selected === row.index ? "bg-accent text-accent-foreground" : "hover:bg-accent"}`}
                    style={{
                      // 避免 WebView 恢复显示时漏绘 transform 定位的虚拟行。
                      top: row.start,
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(names[row.index])}
                  >
                    {names[row.index]}
                  </button>
                ))}
              </div>
            ) : (
              <div
                role="status"
                className="break-words px-2 py-1.5 text-muted-foreground"
              >
                {!ready
                  ? t("directoryDisconnected")
                  : !current
                    ? t("common:loading")
                    : current.error
                      ? t("directoryListFailed", { error: current.error })
                      : t("directoryNoMatches")}
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
