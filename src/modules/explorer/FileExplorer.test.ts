// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement, forwardRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => children,
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

vi.mock("@/components/ui/context-menu", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => children;
  return {
    ContextMenu: Pass,
    ContextMenuContent: Pass,
    ContextMenuItem: Pass,
    ContextMenuSeparator: Pass,
    ContextMenuTrigger: Pass,
  };
});

vi.mock("@/modules/remote", () => ({ remoteNative: {} }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (
    select: (state: { explorerGitDecorations: boolean }) => unknown,
  ) => select({ explorerGitDecorations: false }),
}));
vi.mock("@/modules/shortcuts", () => ({ useGlobalShortcuts: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string } }) => unknown,
  ) => select({ env: { kind: "local" } }),
}));
vi.mock("@hugeicons/core-free-icons", () => ({
  FileAddIcon: {},
  Folder01Icon: {},
  FolderAddIcon: {},
  ListChevronsDownUpIcon: {},
  Refresh01Icon: {},
  Search01Icon: {},
}));
vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 0,
    getVirtualItems: () => [],
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
  EntryRow: () => null,
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
    expand: vi.fn(),
    expanded: new Set<string>(),
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    movePath: vi.fn(),
    nodes: {
      "/home/remote": { status: "loaded", entries: [] },
    },
    pendingCreate: null,
    refresh: vi.fn(),
    renaming: null,
    toggle: vi.fn(),
    trashPath: vi.fn(async () => ({ kind: "trashed" })),
  }),
}));

import { FileExplorer } from "./FileExplorer";

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

  it("routes editable and Markdown files through isolated views", () => {
    expect(viewRegistrySource).toContain('tab.kind === "editor"');
    expect(viewRegistrySource).toContain("<EditorView");
    expect(viewRegistrySource).toContain('tab.kind === "markdown"');
    expect(viewRegistrySource).toContain("<MarkdownView");
  });
});
