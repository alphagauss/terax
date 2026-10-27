// @vitest-environment happy-dom

import { applyTheme, clearTheme } from "@/modules/theme/applyTheme";
import { modern } from "@/modules/theme/themes/modern";
import type { ISearchDecorationOptions } from "@xterm/addon-search";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { act, type ComponentProps, createRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

type FindProps = ComponentProps<typeof import("@/modules/find").FindWidget>;

const harness = vi.hoisted(() => ({
  mode: "dark" as "dark" | "light",
  customThemes: [],
  addon: null as SearchAddon | null,
  widget: null as FindProps | null,
  session: {
    applyTheme: vi.fn(),
    getSelection: () => null,
    focus: vi.fn(),
  },
}));

vi.mock("@/modules/theme", () => ({
  useTheme: () => ({
    resolvedMode: harness.mode,
    themeId: "modern",
    customThemes: harness.customThemes,
  }),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: () => false,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/find", () => ({
  FIND_PRESENCE_MS: 0,
  FindWidget: (props: FindProps) => {
    harness.widget = props;
    return null;
  },
}));
vi.mock("@/components/menu/context-menu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => children,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuShortcut: () => null,
}));
vi.mock("./block/BlockOverlay", () => ({ BlockOverlay: () => null }));
vi.mock("./block/BlockWatermark", () => ({ BlockWatermark: () => null }));
vi.mock("./lib/rendererPool", () => ({}));
vi.mock("./lib/useTerminalSession", async () => {
  const { useEffect } = await import("react");
  return {
    useTerminalSession: ({
      onSearchReady,
    }: {
      onSearchReady: (addon: SearchAddon | null) => void;
    }) => {
      useEffect(() => onSearchReady(harness.addon), [onSearchReady]);
      return harness.session;
    },
  };
});

afterEach(() => {
  clearTheme();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  harness.addon = null;
  harness.widget = null;
});

it("recolors existing terminal matches on mode changes without moving the current match or restoring closed search", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const flushFrames = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  };
  const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
  // 不挂载终端画布，仅为真实搜索插件提供选区服务，保留真实缓冲区与装饰生命周期。
  let selection: ReturnType<Terminal["getSelectionPosition"]>;
  vi.spyOn(term, "getSelectionPosition").mockImplementation(() => selection);
  vi.spyOn(term, "clearSelection").mockImplementation(() => {
    selection = undefined;
  });
  vi.spyOn(term, "select").mockImplementation((x, y, length) => {
    selection = { start: { x, y }, end: { x: x + length, y } };
  });
  const addon = new SearchAddon();
  term.loadAddon(addon);
  await new Promise<void>((resolve) => term.write("one two one", resolve));
  const find = vi.spyOn(addon, "findNext");
  const decorate = vi.spyOn(term, "registerDecoration");
  harness.addon = addon;
  harness.mode = "dark";
  applyTheme(modern, harness.mode);
  const root = createRoot(document.createElement("div"));
  const ref = createRef<TerminalPaneHandle>();
  const render = async () => {
    await act(async () =>
      root.render(
        <TerminalPane
          ref={ref}
          terminalId={1}
          visible
          focused={harness.mode === "dark"}
        />,
      ),
    );
    await flushFrames();
  };
  const widget = () => {
    if (!harness.widget) throw new Error("Find widget is not mounted");
    return harness.widget;
  };
  try {
    await render();
    await act(async () => ref.current?.open());
    await flushFrames();
    await act(async () => widget().onQueryChange("one"));
    expect(decorate.mock.lastCall?.[0].backgroundColor).toBe(
      modern.variants.dark?.colors?.searchCurrentMatchBackground,
    );
    const previousDisposed = vi.fn();
    decorate.mock.results[decorate.mock.results.length - 1]?.value?.onDispose(
      previousDisposed,
    );
    await act(async () => widget().onNext?.());
    expect(selection?.start.x).toBe(8);
    expect(previousDisposed).toHaveBeenCalledOnce();

    harness.mode = "light";
    applyTheme(modern, harness.mode);
    decorate.mockClear();
    await render();

    expect(selection?.start.x).toBe(8);
    expect(widget().result).toMatchObject({ current: 2, total: 2 });
    const colors: ISearchDecorationOptions | undefined =
      find.mock.lastCall?.[1]?.decorations;
    expect(colors).toMatchObject({
      matchBackground: "#ffef5a",
      activeMatchBackground: "#ffa84d",
      activeMatchColorOverviewRuler: "#ffa84d",
    });
    expect(colors).not.toHaveProperty("matchBorder");
    expect(colors).not.toHaveProperty("activeMatchBorder");
    expect(
      decorate.mock.calls.map(([options]) => options.backgroundColor),
    ).toEqual([
      colors?.matchBackground,
      colors?.matchBackground,
      colors?.activeMatchBackground,
    ]);

    const activeDisposed = vi.fn();
    decorate.mock.results[decorate.mock.results.length - 1]?.value?.onDispose(
      activeDisposed,
    );
    await act(async () => widget().onClose());
    expect(activeDisposed).toHaveBeenCalledOnce();
    find.mockClear();
    harness.mode = "dark";
    applyTheme(modern, harness.mode);
    await render();
    expect(find).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    term.dispose();
  }
});
