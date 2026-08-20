/**
 * 本文件验证文件资源管理器在目录根异步变化时保持 Hook 顺序，
 * 并锁定顶部创建目标、根目录标题交互、SSH 恢复状态、Local 目录选择入口与非本地 Workspace 的后台传输入口。
 */

// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, forwardRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environmentKind: "local",
  rootStatus: "loaded",
  remoteReady: true,
  runtimePhase: "idle",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.environmentKind = "local";
  mocks.rootStatus = "loaded";
  mocks.remoteReady = true;
  mocks.runtimePhase = "idle";
});

vi.mock("@/components/ui/button", () => ({
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

vi.mock("@/components/ui/alert-dialog", () => {
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
    ContextMenuItem: Pass,
    ContextMenuSeparator: Pass,
    ContextMenuSub: Pass,
    ContextMenuSubContent: Pass,
    ContextMenuSubTrigger: Pass,
    ContextMenuTrigger: Pass,
  };
});

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
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string; profileId?: string } }) => unknown,
  ) =>
    select({
      env: { kind: mocks.environmentKind, profileId: "server" },
    }),
}));
vi.mock("@hugeicons/core-free-icons", () => ({
  FileAddIcon: {},
  Folder01Icon: {},
  FolderAddIcon: {},
  FolderOpenIcon: {},
  ListChevronsDownUpIcon: {},
  Refresh01Icon: {},
  Search01Icon: {},
}));
vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () =>
      count > 0 ? [{ index: 0, key: "first-row", size: 24, start: 0 }] : [],
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./ExplorerSearch", () => ({
  ExplorerSearch: forwardRef(() => null),
}));
vi.mock("./InlineInput", () => ({ InlineInput: () => null }));
vi.mock("./TreeRow", () => ({
  EntryRow: ({ path, name }: { path: string; name: string }) =>
    createElement("div", { "data-fs-path": path }, name),
  PendingRow: () => null,
  StatusRow: () => null,
}));
vi.mock("./lib/contextActions", () => ({
  copyToClipboard: vi.fn(),
  relativePath: vi.fn(),
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
  useExplorerFileDrop: () => ({ externalTargetDir: null }),
}));
vi.mock("./lib/useGitStatus", () => ({
  useGitStatus: () => ({ lookup: () => null }),
}));
vi.mock("./lib/useFileTree", () => ({
  ancestorDirs: () => [],
  useFileTree: () => ({
    beginCreate: vi.fn(),
    beginRename: vi.fn(),
    cancelCreate: vi.fn(),
    cancelRename: vi.fn(),
    collapseAll: vi.fn(),
    commitCreate: vi.fn(),
    commitRename: vi.fn(),
    deletePath: vi.fn(),
    deletingPaths: new Set<string>(),
    expand: vi.fn(),
    expanded: new Set<string>(),
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    movePath: vi.fn(),
    nodes: {
      "/home/remote": {
        status: mocks.rootStatus,
        entries: [{ name: "file.txt", kind: "file", gitignored: false }],
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
} from "./FileExplorer";

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
    expect(container.textContent).toContain("menu.open");

    act(() =>
      title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(container.textContent).not.toContain("menu.open");
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
