/** Windows 编辑菜单：浏览器执行原生编辑命令，CodeMirror 独立处理自身的撤销历史。 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { EditorView } from "@codemirror/view";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { IS_WINDOWS } from "@/lib/platform";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
} from "@/components/menu/context-menu";

type Action = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";
type Menu = {
  id: string;
  connection: string;
  items: { id: number; name: Action; shortcut: string; enabled: boolean }[];
};
type Target = {
  x: number;
  y: number;
  focus: HTMLElement;
  container: HTMLElement | null;
};
type Request = {
  menu: Menu;
  target: Target;
  active: () => boolean;
  editor: {
    view: EditorView;
    commands: Pick<
      typeof import("@codemirror/commands"),
      "undo" | "redo" | "undoDepth" | "redoDepth"
    >;
  } | null;
};

// 同一文档内串行连接与卸载，避免 Strict Mode 或热更新的异步初始化覆盖新连接。
let lifecycle: Promise<void> = Promise.resolve();

function finish(menu: Menu, command: number | null, restoreNative = false) {
  return invoke<boolean>("editor_menu_finish", {
    connection: menu.connection,
    id: menu.id,
    command,
    restoreNative,
  });
}

/** 非 Windows 不建立监听，保留宿主原有菜单与快捷键行为。 */
export function EditorContextMenu() {
  return IS_WINDOWS ? <WindowsEditorContextMenu /> : null;
}

function WindowsEditorContextMenu() {
  const [request, setRequest] = useState<Request | null>(null);
  useEffect(() => {
    const connection = crypto.randomUUID();
    const nativeWindow = getCurrentWebviewWindow();
    const unlisten: UnlistenFn[] = [];
    let disposed = false;
    let latest: string | null = null;
    let target: Target | null = null;
    const capture = (event: MouseEvent) => {
      target = null;
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const element = event.target;
      if (element.closest(".xterm, [role='menu']")) return;
      const focus =
        element
          .closest(".cm-editor")
          ?.querySelector<HTMLElement>(".cm-content") ??
        element.closest<HTMLElement>("input, textarea, [contenteditable]");
      if (
        !focus ||
        (focus instanceof HTMLInputElement && focus.type === "password")
      )
        return;
      target = {
        focus,
        x: event.clientX,
        y: event.clientY,
        container: element.closest<HTMLElement>('[role="dialog"]'),
      };
    };
    window.addEventListener("contextmenu", capture);
    lifecycle = lifecycle
      .catch(() => {})
      .then(async () => {
        if (disposed) return;
        try {
          unlisten.push(
            await nativeWindow.listen<Menu>(
              "editor-menu-requested",
              ({ payload }) => {
                if (disposed || payload.connection !== connection) return;
                const current = target;
                target = null;
                latest = payload.id;
                if (!current?.focus.isConnected) {
                  void finish(payload, null, true).catch((error) =>
                    console.error("恢复原生编辑菜单失败", error),
                  );
                  return;
                }
                void (async () => {
                  let editor: Request["editor"] = null;
                  // 按需加载，普通输入框不引入编辑器运行时。
                  if (current.focus.closest(".cm-editor")) {
                    const [{ EditorView }, commands] = await Promise.all([
                      import("@codemirror/view"),
                      import("@codemirror/commands"),
                    ]);
                    const view = EditorView.findFromDOM(current.focus);
                    if (view) editor = { view, commands };
                  }
                  if (
                    disposed ||
                    latest !== payload.id ||
                    !current.focus.isConnected
                  ) {
                    await finish(payload, null);
                    return;
                  }
                  setRequest({
                    menu: payload,
                    target: current,
                    editor,
                    active: () => !disposed && latest === payload.id,
                  });
                })().catch((error) => {
                  console.error("打开编辑菜单失败", error);
                  void finish(payload, null, true).catch(() => {});
                });
              },
            ),
          );
          unlisten.push(
            await nativeWindow.listen<Menu>(
              "editor-menu-closed",
              ({ payload }) => {
                if (disposed || payload.connection !== connection) return;
                if (latest === payload.id) latest = null;
                setRequest((current) =>
                  current?.menu.id === payload.id ? null : current,
                );
              },
            ),
          );
          if (!disposed) await invoke("editor_menu_connect", { connection });
        } catch (error) {
          for (const off of unlisten.splice(0)) off();
          console.error("建立编辑菜单连接失败", error);
        }
      });
    return () => {
      disposed = true;
      window.removeEventListener("contextmenu", capture);
      lifecycle = lifecycle
        .catch(() => {})
        .then(async () => {
          try {
            await invoke("editor_menu_disconnect", { connection });
          } finally {
            for (const off of unlisten.splice(0)) off();
          }
        })
        .catch((error) => console.error("释放编辑菜单连接失败", error));
    };
  }, []);
  return (
    request && (
      <EditMenu
        key={request.menu.id}
        request={request}
        close={() =>
          setRequest((current) =>
            current?.menu.id === request.menu.id ? null : current,
          )
        }
      />
    )
  );
}

/** 菜单使用打开时的目标，原生请求完成后才执行编辑器历史命令，避免一次操作执行两遍。 */
function EditMenu({ request, close }: { request: Request; close: () => void }) {
  const { t } = useTranslation("common");
  const trigger = useRef<HTMLSpanElement>(null);
  const chosen = useRef<number | "undo" | "redo" | null>(null);
  const completed = useRef(false);
  const { editor, menu, target } = request;
  const items = editor
    ? [
        ...(["undo", "redo"] as const).map((name) => ({
          id: null,
          name,
          shortcut: name === "undo" ? "Ctrl+Z" : "Ctrl+Shift+Z",
          enabled:
            !editor.view.state.readOnly &&
            (name === "undo"
              ? editor.commands.undoDepth(editor.view.state)
              : editor.commands.redoDepth(editor.view.state)) > 0,
        })),
        ...menu.items.filter(
          (item) => item.name !== "undo" && item.name !== "redo",
        ),
      ]
    : menu.items;
  useEffect(() => {
    trigger.current?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: target.x,
        clientY: target.y,
      }),
    );
  }, [target]);
  const complete = async () => {
    if (completed.current) return;
    completed.current = true;
    const choice =
      request.active() && target.focus.isConnected ? chosen.current : null;
    try {
      const done = await finish(
        menu,
        typeof choice === "number" ? choice : null,
      );
      if (choice !== null && !done) throw new Error("editor menu expired");
      if (
        done &&
        typeof choice === "string" &&
        request.active() &&
        editor?.view.dom.isConnected
      ) {
        editor.view.focus();
        editor.commands[choice](editor.view);
      }
    } catch (error) {
      console.error("执行编辑菜单失败", error);
      if (choice !== null) toast.error(t("editorMenu.failed"));
    } finally {
      close();
    }
  };
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <span
          ref={trigger}
          aria-hidden="true"
          className="pointer-events-none fixed h-0 w-0"
        />
      </ContextMenuTrigger>
      <ContextMenuContent
        portalContainer={target.container ?? undefined}
        onCloseAutoFocus={(event) => {
          if (
            chosen.current !== null &&
            request.active() &&
            target.focus.isConnected
          ) {
            event.preventDefault();
            target.focus.focus({ preventScroll: true });
          }
          queueMicrotask(() => void complete());
        }}
      >
        {items.map((item) => (
          <ContextMenuItem
            key={item.name}
            disabled={!item.enabled}
            onSelect={() => {
              chosen.current =
                editor && (item.name === "undo" || item.name === "redo")
                  ? item.name
                  : item.id;
            }}
          >
            {t(`editorMenu.${item.name}`)}
            <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut>
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
