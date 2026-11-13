/**
 * 本文件验证文件资源管理器在目录根异步变化时保持 Hook 顺序，
 * 并锁定顶部创建目标、根目录标题交互、SSH 恢复状态、Local 目录选择入口与非本地 Workspace 的后台传输入口。
 */

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environmentKind: "local",
  empty: false,
  pasteFiles: vi.fn(),
  invoke: vi.fn(),
  reportError: vi.fn(),
  rootStatus: "loaded",
  remoteReady: true,
  runtimePhase: "idle",
  names: ["file.txt"],
  childNodes: {} as Record<string, { status: string; entries?: unknown[] }>,
  expand: vi.fn(),
  searching: false,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.environmentKind = "local";
  mocks.empty = false;
  mocks.pasteFiles.mockClear();
  mocks.invoke.mockReset();
  mocks.reportError.mockClear();
  mocks.rootStatus = "loaded";
  mocks.remoteReady = true;
  mocks.runtimePhase = "idle";
  mocks.names = ["file.txt"];
  mocks.childNodes = {};
  mocks.expand.mockClear();
  mocks.searching = false;
});

vi.mock("@/components/controls/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => createElement("button", { type: "button", ...props }, children),
}));
vi.mock("@/components/ui/spinner", () => ({
  Spinner: () => createElement("span", null, "spinner"),
}));

vi.mock("@/components/controls/alert-dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => children;
  return {
    AlertDialog: Pass,
    AlertDialogAction: Pass,
    AlertDialogCancel: Pass,
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
  };
});

vi.mock("@/components/menu/context-menu", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => children;
  return {
    ContextMenu: Pass,
    ContextMenuContent: Pass,
    ContextMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children?: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) =>
      createElement(
        "button",
        { type: "button", disabled, onClick: onSelect },
        children,
      ),
    ContextMenuSeparator: Pass,
    ContextMenuShortcut: () => null,
    ContextMenuSub: Pass,
    ContextMenuSubContent: Pass,
    ContextMenuSubTrigger: Pass,
    ContextMenuTrigger: Pass,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@/lib/errors", () => ({ reportError: mocks.reportError }));

vi.mock("@/modules/transfers/dialogs", () => ({
  pickDownloadDirectory: vi.fn(),
  pickUploadFiles: vi.fn(),
  pickUploadFolders: vi.fn(),
}));
vi.mock("@/modules/transfers/native", () => ({
  transferNative: { enqueue: vi.fn() },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (
    select: (state: { explorerGitDecorations: boolean }) => unknown,
  ) => select({ explorerGitDecorations: false }),
}));
vi.mock("@/modules/remote", () => ({
  useRemoteRuntimeStore: (
    select: (state: { snapshot: Record<string, unknown> }) => unknown,
  ) =>
    select({
      snapshot:
        mocks.runtimePhase === "idle"
          ? { phase: "idle", version: 0 }
          : {
              phase: mocks.runtimePhase,
              version: 1,
              profileId: "server",
              reason: "offline",
            },
    }),
}));
vi.mock("@/modules/shortcuts", () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({
    kind: mocks.environmentKind,
    profileId: "server",
  }),
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string; profileId?: string } }) => unknown,
  ) =>
    select({
      env: { kind: mocks.environmentKind, profileId: "server" },
    }),
}));

vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/modules/source-control/RepositoryContext", () => ({
  useRepositorySnapshot: () => ({
    repo: { repoRoot: "/home/remote" },
    status: { headSha: "head" },
    revision: 1,
  }),
}));
vi.mock("@/modules/git-history/FileTimeline", () => ({
  FileTimeline: ({
    path,
    enabled,
  }: {
    path: string | null;
    enabled: boolean;
  }) =>
    createElement("div", {
      "data-timeline-path": path ?? "",
      "data-timeline-enabled": enabled,
    }),
}));
vi.mock("@/modules/sidebar", () => ({
  SidebarSectionGroup: ({
    sections,
  }: {
    sections: {
      id: string;
      fixedHeader?: React.ReactNode;
      render: (state: {
        expanded: boolean;
        present: boolean;
      }) => React.ReactNode;
    }[];
  }) =>
    sections.map((section) =>
      createElement(
        "section",
        { key: section.id },
        section.fixedHeader,
        section.render({ expanded: true, present: true }),
      ),
    ),
  SidebarSectionAction: () => null,
}));
vi.mock("./ExplorerSearch", () => ({
  ExplorerSearch: function ExplorerSearch({
    open,
    onActiveChange,
  }: {
    open: boolean;
    onActiveChange: (active: boolean) => void;
  }) {
    const active = open && mocks.searching;
    useEffect(() => onActiveChange(active), [active, onActiveChange]);
    return null;
  },
}));
vi.mock("./InlineInput", () => ({ InlineInput: () => null }));
vi.mock("./TreeRow", () => ({
  EntryRow: ({
    path,
    name,
    domId,
    isCut,
  }: {
    path: string;
    name: string;
    domId: string;
    isCut?: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-fs-path": path,
        "data-fs-cut": isCut ? "" : undefined,
        id: domId,
      },
      name,
    ),
  PendingRow: () => null,
  StatusRow: () => null,
}));
vi.mock("./lib/contextActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/contextActions")>()),
  copyToClipboard: vi.fn(),
  revealInFinder: vi.fn(),
}));
vi.mock("./lib/iconResolver", () => ({
  fileIconUrl: () => "file-icon",
  folderIconUrl: () => "folder-icon",
}));
vi.mock("./lib/useExplorerDnd", () => ({
  useExplorerDnd: () => ({
    dragLabel: null,
    dropTargetDir: null,
    ghostRef: vi.fn(),
    onClickCapture: vi.fn(),
    onPointerDown: vi.fn(),
  }),
}));
vi.mock("./lib/useExplorerFileDrop", () => ({
  useExplorerFileDrop: () => ({
    externalTargetDir: null,
    pasteFiles: mocks.pasteFiles,
  }),
}));
vi.mock("./lib/useGitStatus", () => ({
  useGitStatus: () => ({ lookup: () => null }),
}));
vi.mock("./lib/useFileTree", () => ({
  ancestorDirs: () => [],
  dirname: (value: string) => value.slice(0, value.lastIndexOf("/")),
  useFileTree: (rootPath: string | null) => ({
    beginCreate: vi.fn(),
    beginRename: vi.fn(),
    cancelCreate: vi.fn(),
    cancelRename: vi.fn(),
    collapseAll: vi.fn(),
    commitCreate: vi.fn(),
    commitRename: vi.fn(),
    deletePath: vi.fn(),
    deletingPaths: new Set<string>(),
    expand: mocks.expand,
    expanded: new Set(
      Object.entries(mocks.childNodes)
        .filter(([, node]) => node.status !== "idle")
        .map(([path]) => path),
    ),
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    movePath: vi.fn(),
    nodes: {
      ...mocks.childNodes,
      [rootPath ?? ""]: {
        status: mocks.rootStatus,
        entries: mocks.empty
          ? []
          : mocks.names.map((name) => ({
              name,
              kind: mocks.childNodes[`${rootPath}/${name}`] ? "dir" : "file",
              gitignored: false,
            })),
      },
    },
    pendingCreate: null,
    remoteReady: mocks.remoteReady,
    refresh: vi.fn(),
    renaming: null,
    toggle: vi.fn(),
    trashPath: vi.fn(async () => ({ kind: "trashed" })),
  }),
}));

import {
  FileExplorer,
  resolvePendingCreateIndex,
  resolveToolbarCreateParent,
} from "@/modules/explorer/FileExplorer";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "FileExplorer.tsx"), "utf8");
const editorSource = readFileSync(
  path.join(here, "../editor/EditorPane.tsx"),
  "utf8",
);
const viewRegistrySource = readFileSync(
  path.join(here, "../workbench/viewRegistry.tsx"),
  "utf8",
);

it("keeps every file row mounted across sidebar switches and locates the active file", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.names = Array.from({ length: 80 }, (_, index) => `file-${index}.txt`);
  const container = document.createElement("div");
  const root = createRoot(container);
  const props = { rootPath: "/home/remote", onOpenFile: vi.fn() };
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  try {
    await act(async () => root.render(createElement(FileExplorer, props)));
    const rows = [...container.querySelectorAll<HTMLElement>("[data-fs-path]")];
    expect(rows).toHaveLength(80);
    const tree = container.querySelector<HTMLElement>('[role="tree"]');
    if (!tree) throw new Error("Missing file tree");
    Object.defineProperty(tree, "clientHeight", { value: 240 });
    vi.spyOn(tree, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 240),
    );
    vi.spyOn(rows[79], "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 1896, 200, 24),
    );
    for (const active of [false, true]) {
      await act(async () =>
        root.render(createElement(FileExplorer, { ...props, active })),
      );
      const current = container.querySelectorAll("[data-fs-path]");
      expect(current).toHaveLength(rows.length);
      rows.forEach((row, index) => {
        expect(current[index]).toBe(row);
      });
    }
    await act(async () =>
      root.render(
        createElement(FileExplorer, {
          ...props,
          activeFilePath: "/home/remote/file-79.txt",
        }),
      ),
    );
    await act(async () => {
      for (const callback of frames.splice(0)) callback(0);
    });
    expect(
      container
        .querySelector("[data-timeline-path]")
        ?.getAttribute("data-timeline-path"),
    ).toBe("/home/remote/file-79.txt");
    expect(tree.scrollTop).toBe(1680);
    expect(tree.getAttribute("aria-activedescendant")).toBe(rows[79].id);
    await act(async () => {
      tree.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    expect(tree.getAttribute("aria-activedescendant")).toBe(rows[78].id);
    await act(async () => {
      tree.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(props.onOpenFile).toHaveBeenCalledWith("/home/remote/file-78.txt");
    expect(
      container
        .querySelector("[data-timeline-path]")
        ?.getAttribute("data-timeline-path"),
    ).toBe("/home/remote/file-78.txt");
    await act(async () =>
      root.render(
        createElement(FileExplorer, {
          ...props,
          activeFilePath: null,
          active: false,
        }),
      ),
    );
    expect(
      container
        .querySelector("[data-timeline-path]")
        ?.getAttribute("data-timeline-path"),
    ).toBe("/home/remote/file-78.txt");
    expect(
      container
        .querySelector("[data-timeline-enabled]")
        ?.getAttribute("data-timeline-enabled"),
    ).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});

it("从 Git 再次打开同一工作区文件时，在资源管理器可见后定位", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rootPath = "d:/project";
  const parent = `${rootPath}/Src`;
  mocks.names = ["Src", "other.txt"];
  mocks.childNodes[parent] = { status: "idle" };
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (
    active: boolean,
    activeFileRevealVersion = 1,
    activeFilePath: string | null = "D:/Project/src/file.txt",
  ) =>
    act(async () =>
      root.render(
        createElement(FileExplorer, {
          rootPath,
          active,
          activeFileRevealVersion,
          activeFilePath,
          onOpenFile: vi.fn(),
        }),
      ),
    );
  const tree = () => container.querySelector('[role="tree"]');
  const selected = () => tree()?.getAttribute("aria-activedescendant");
  const fileId = `file-tree-item-${encodeURIComponent(`${parent}/File.txt`)}`;
  try {
    await render(false);
    expect(mocks.expand).not.toHaveBeenCalled();
    await render(true);
    expect(mocks.expand).toHaveBeenCalledWith(parent);
    expect(selected()).toBeNull();

    mocks.childNodes[parent] = {
      status: "loaded",
      entries: [{ name: "File.txt", kind: "file" }],
    };
    await render(true);
    expect(selected()).toBe(fileId);

    await act(async () => {
      tree()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    const otherId = `file-tree-item-${encodeURIComponent(`${rootPath}/other.txt`)}`;
    expect(selected()).toBe(otherId);
    await render(false, 1, null);
    await render(true, 1, null);
    expect(selected()).toBe(otherId);
    await render(true);
    expect(selected()).toBe(otherId);
    await render(false, 2);
    expect(selected()).toBe(otherId);
    await render(true, 2);
    expect(selected()).toBe(fileId);

    mocks.expand.mockClear();
    await render(true, 3, "D:/Project/src/removed/file.txt");
    await render(true, 4, "D:/Project-other/src/file.txt");
    expect(mocks.expand).not.toHaveBeenCalled();
    expect(selected()).toBe(fileId);

    mocks.searching = true;
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="searchFiles"]')
        ?.click(),
    );
    expect(tree()).toBeNull();
    await render(false, 5);
    expect(tree()).toBeNull();
    await render(true, 5);
    expect(selected()).toBe(fileId);
  } finally {
    await act(async () => root.unmount());
  }
});

it("恢复时等待所选文件的父目录加载完成，再判断选中项是否消失", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.names = ["src"];
  const parent = "/home/remote/src";
  const selected = `${parent}/file.txt`;
  mocks.childNodes[parent] = {
    status: "loaded",
    entries: [{ name: "file.txt", kind: "file", gitignored: false }],
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const props = { rootPath: "/home/remote", onOpenFile: vi.fn() };
  const selectedRow = () =>
    container
      .querySelector('[role="tree"]')
      ?.getAttribute("aria-activedescendant");
  const selectedId = `file-tree-item-${encodeURIComponent(selected)}`;
  try {
    await act(async () =>
      root.render(
        createElement(FileExplorer, {
          ...props,
          activeFilePath: selected,
        }),
      ),
    );
    expect(selectedRow()).toBe(selectedId);
    mocks.childNodes[parent] = { status: "loading" };
    await act(async () => root.render(createElement(FileExplorer, props)));
    expect(selectedRow()).toBe(selectedId);
    mocks.childNodes[parent] = { status: "loaded", entries: [] };
    await act(async () =>
      root.render(createElement(FileExplorer, { ...props, active: true })),
    );
    expect(selectedRow()).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

function expectNoHooksAfter(sourceText: string, marker: string) {
  const earlyReturn = sourceText.indexOf(marker);

  expect(earlyReturn).toBeGreaterThan(-1);
  expect(sourceText.slice(earlyReturn)).not.toMatch(/\buse[A-Z]\w*\s*\(/);
}

describe("toolbar create parent", () => {
  it("uses the selected folder", () => {
    expect(
      resolveToolbarCreateParent("/workspace", "/workspace/src", true),
    ).toBe("/workspace/src");
  });

  it("uses the selected file's direct parent", () => {
    expect(
      resolveToolbarCreateParent("/workspace", "/workspace/src/app.tsx", false),
    ).toBe("/workspace/src");
    expect(
      resolveToolbarCreateParent(
        "C:\\workspace",
        "C:\\workspace\\src\\app.tsx",
        false,
      ),
    ).toBe("C:\\workspace\\src");
  });

  it("falls back to the workspace root without a valid selection", () => {
    expect(resolveToolbarCreateParent("/workspace", null, undefined)).toBe(
      "/workspace",
    );
    expect(
      resolveToolbarCreateParent("/workspace", "/workspace/missing", undefined),
    ).toBe("/workspace");
  });
});

describe("pending create position", () => {
  const entries = [
    { kind: "dir" as const },
    { kind: "dir" as const },
    { kind: "symlink" as const },
    { kind: "file" as const },
  ];

  it("places a folder draft before every entry", () => {
    expect(resolvePendingCreateIndex(entries, "dir")).toBe(0);
  });

  it("places a file draft after folders and before files", () => {
    expect(resolvePendingCreateIndex(entries, "file")).toBe(2);
    expect(
      resolvePendingCreateIndex([{ kind: "dir" }, { kind: "dir" }], "file"),
    ).toBe(2);
  });
});

describe("root title interactions", () => {
  it("smoothly scrolls the file tree to the top and respects reduced motion", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
        }),
      ),
    );

    const title = container.querySelector<HTMLButtonElement>(
      'button[data-explorer-context="root"]',
    );
    const tree = container.querySelector<HTMLElement>('[role="tree"]');
    expect(title).not.toBeNull();
    expect(tree).not.toBeNull();
    if (!title || !tree) return;

    const scrollTo = vi.fn();
    tree.scrollTo = scrollTo;
    tree.scrollTop = 120;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    act(() => title.click());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });

    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    act(() => title.click());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    act(() => root.unmount());
  });

  it("uses the root menu after a file row was the previous context target", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
        }),
      ),
    );

    const row = container.querySelector<HTMLElement>("[data-fs-path]");
    const title = container.querySelector<HTMLElement>(
      '[data-explorer-context="root"]',
    );
    expect(row).not.toBeNull();
    expect(title).not.toBeNull();
    if (!row || !title) return;

    act(() =>
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(container.textContent).toContain("fileActions.open");

    act(() =>
      title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(
      [...container.querySelectorAll("*")].some(
        (element) => element.textContent === "fileActions.open",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("menu.refresh");
    act(() => root.unmount());
  });
});

describe("file opening render path", () => {
  it("keeps hooks before nullable render exits", () => {
    expectNoHooksAfter(source, "if (!rootPath) {");
    expectNoHooksAfter(editorSource, 'if (doc.status === "loading") {');
  });

  it("keeps the hook order when the SSH root resolves asynchronously", () => {
    const props = { rootPath: null, onOpenFile: vi.fn() };
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => root.render(createElement(FileExplorer, props)));
    expect(container.textContent).toContain("noCurrentDirectory");

    act(() =>
      root.render(
        createElement(FileExplorer, { ...props, rootPath: "/home/remote" }),
      ),
    );
    expect(container.textContent).toContain("remote");
    act(() => root.unmount());
  });

  it("only shows root loading when the parent marks a real page as pending", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const props = { rootPath: null, onOpenFile: vi.fn() };

    act(() => root.render(createElement(FileExplorer, props)));
    expect(container.textContent).toContain("noCurrentDirectory");
    expect(container.textContent).not.toContain("spinner");

    act(() =>
      root.render(
        createElement(FileExplorer, { ...props, rootPending: "loading" }),
      ),
    );
    expect(container.textContent).toContain("spinner");
    expect(container.textContent).toContain("loading");
    expect(container.textContent).not.toContain("noCurrentDirectory");
    act(() => root.unmount());
  });

  it("shows SSH connection progress while a remote workspace boots", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: null,
          rootPending: "connection",
          onOpenFile: vi.fn(),
        }),
      ),
    );

    expect(container.textContent).toContain("remoteWorkspace.connecting");
    expect(container.textContent).toContain("spinner");
    expect(container.textContent).not.toContain("noCurrentDirectory");

    mocks.environmentKind = "ssh";
    mocks.remoteReady = false;
    mocks.runtimePhase = "reconnecting";
    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain("remoteWorkspace.reconnecting");
    act(() => root.unmount());
  });

  it("offers manual reconnect after automatic recovery stops", () => {
    mocks.environmentKind = "ssh";
    mocks.remoteReady = false;
    mocks.runtimePhase = "disconnected";
    const onReconnect = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
          onReconnect,
        }),
      ),
    );

    expect(container.textContent).toContain("remoteWorkspace.manualReconnect");
    expect(container.textContent).not.toContain("spinner");
    act(() => container.querySelector("button")?.click());
    expect(onReconnect).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("keeps an animated indicator while the first root directory is loading", () => {
    mocks.rootStatus = "loading";
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain("spinner");
    expect(container.textContent).toContain("loading");
    act(() => root.unmount());
  });

  it("only renders the folder picker entry when the parent supplies it", () => {
    const props = { rootPath: null, onOpenFile: vi.fn() };
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => root.render(createElement(FileExplorer, props)));
    expect(container.textContent).not.toContain("openFolder");

    act(() =>
      root.render(
        createElement(FileExplorer, {
          ...props,
          onOpenFolder: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain("openFolder");
    act(() => root.unmount());
  });

  it("renders lightweight remote Home and path entries when supplied", () => {
    mocks.environmentKind = "ssh";
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: null,
          onOpenFile: vi.fn(),
          onOpenHome: vi.fn(),
          onOpenPath: vi.fn(),
        }),
      ),
    );

    expect(container.textContent).toContain("openHome");
    expect(container.textContent).toContain("openPath");
    expect(container.textContent).not.toContain("openFolder");
    act(() => root.unmount());
  });

  it("routes editable and Markdown files through isolated views", () => {
    expect(viewRegistrySource).toContain('tab.kind === "editor"');
    expect(viewRegistrySource).toContain("<EditorView");
    expect(viewRegistrySource).toContain('tab.kind === "markdown"');
    expect(viewRegistrySource).toContain("<MarkdownView");
  });

  it("keeps a loading surface for the visible cold terminal", () => {
    expect(viewRegistrySource).toContain(
      'currentWorkspaceEnv().kind === "local"',
    );
    expect(viewRegistrySource).toContain('tab.kind !== "terminal"');
    expect(viewRegistrySource).toContain("<Spinner");
  });

  it("offers Direct and Archive transfers in a WSL workspace", () => {
    mocks.environmentKind = "wsl";
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
        }),
      ),
    );

    expect(container.textContent).toContain("menu.uploadFiles");
    expect(container.textContent).toContain("menu.uploadFolder");
    expect(source).toContain("enqueueDownload(menuTarget.path, strategy)");
    expect(source).toContain("<TransferStrategyMenu");
    expect(source).toContain("transferNative.enqueue");
    act(() => root.unmount());
  });
});

it("空目录也能粘贴，目标与顶部新建按钮一致", async () => {
  mocks.empty = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
        }),
      ),
    );
    const tree = container.querySelector('[role="tree"]');
    const event = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => tree?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.pasteFiles).toHaveBeenCalledWith(
      resolveToolbarCreateParent("/home/remote", null, undefined),
    );
  } finally {
    act(() => root.unmount());
  }
});

it("右键粘贴使用点击的目录，移动失败后保留剪切并允许重试", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const directory = "/home/remote/target";
  const sourcePath = "/home/remote/file.txt";
  const landedPath = `${directory}/file copy.txt`;
  mocks.names = ["file.txt", "target"];
  mocks.childNodes = {
    [directory]: {
      status: "loaded",
      entries: [{ name: "file copy.txt", kind: "file" }],
    },
  };
  const paste = vi
    .fn()
    .mockRejectedValueOnce({ kind: "io", detail: "busy" })
    .mockResolvedValueOnce("file copy.txt");
  mocks.invoke.mockImplementation((command, args) =>
    command === "fs_paste" ? paste(args) : Promise.resolve(undefined),
  );
  const onPathRenamed = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const row = (path: string) =>
    container.querySelector(`[data-fs-path="${path}"]`);
  const context = (path: string) =>
    act(() =>
      row(path)?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      ),
    );
  const menu = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
  const key = (key: string, ctrlKey = false) =>
    container.querySelector('[role="tree"]')?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  try {
    act(() =>
      root.render(
        createElement(FileExplorer, {
          rootPath: "/home/remote",
          onOpenFile: vi.fn(),
          onPathRenamed,
        }),
      ),
    );
    context(sourcePath);
    act(() => key("x", true));
    expect(row(sourcePath)?.hasAttribute("data-fs-cut")).toBe(true);

    context(directory);
    act(() => key("ArrowUp"));
    await act(async () => menu("menu.paste")?.click());
    expect(paste).toHaveBeenCalledWith({
      source: sourcePath,
      destination: directory,
      mode: "cut",
      workspace: expect.objectContaining({ kind: "local" }),
    });
    expect(mocks.reportError).toHaveBeenCalledOnce();
    expect(row(sourcePath)?.hasAttribute("data-fs-cut")).toBe(true);
    expect(onPathRenamed).not.toHaveBeenCalled();

    await act(async () => menu("menu.paste")?.click());
    expect(paste).toHaveBeenCalledTimes(2);
    expect(row(sourcePath)?.hasAttribute("data-fs-cut")).toBe(false);
    expect(onPathRenamed).toHaveBeenCalledWith(sourcePath, landedPath);
    expect(
      container
        .querySelector('[role="tree"]')
        ?.getAttribute("aria-activedescendant"),
    ).toBe(`file-tree-item-${encodeURIComponent(landedPath)}`);

    context(sourcePath);
    act(() => key("x", true));
    expect(row(sourcePath)?.hasAttribute("data-fs-cut")).toBe(true);
    act(() => key("Escape"));
    expect(row(sourcePath)?.hasAttribute("data-fs-cut")).toBe(false);
  } finally {
    act(() => key("Escape"));
    act(() => root.unmount());
  }
});
