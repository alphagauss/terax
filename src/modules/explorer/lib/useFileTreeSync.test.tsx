// @vitest-environment happy-dom

import { ViewStateScope } from "@/modules/view-state";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  retainWatch: vi.fn(() => vi.fn()),
  changed: null as ((paths: string[]) => void) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/filesystem", () => ({
  retainDirectoryWatch: mocks.retainWatch,
  subscribeWorkspaceResume: () => () => {},
  subscribeFileSystemChanges: (
    _workspace: unknown,
    listener: (paths: string[]) => void,
  ) => {
    mocks.changed = listener;
    return () => {
      mocks.changed = null;
    };
  },
}));

import { useFileTree } from "./useFileTree";
import {
  readCachedDirectory,
  resetDirectoryCacheForTests,
} from "./directoryCache";

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.retainWatch.mockClear();
  resetDirectoryCacheForTests();
});

it("preserves live tree and editing state across visibility changes even without cached directories", async () => {
  const rootPath = "/visibility-state-test";
  mocks.invoke.mockImplementation((_command, { path }) =>
    Promise.resolve(
      path === rootPath
        ? [
            { name: "src", kind: "dir" },
            { name: "file.txt", kind: "file" },
          ]
        : [{ name: "child.txt", kind: "file" }],
    ),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  let tree!: ReturnType<typeof useFileTree>;
  function Probe({
    active,
    path = rootPath,
  }: {
    active: boolean;
    path?: string | null;
  }) {
    return (
      <ViewStateScope
        kind="sidebar"
        scope={path ?? "empty"}
        view="explorer"
        visible={active}
      >
        <Tree path={path} active={active} />
      </ViewStateScope>
    );
  }
  function Tree({ path, active }: { path: string | null; active: boolean }) {
    tree = useFileTree(path, { active });
    return null;
  }
  try {
    await act(async () => root.render(<Probe active />));
    await act(async () => tree.expand(`${rootPath}/src`));
    const nodes = tree.nodes;
    const expanded = tree.expanded;
    await act(async () => tree.beginRename(`${rootPath}/file.txt`));
    resetDirectoryCacheForTests();
    await act(async () => root.render(<Probe active={false} />));
    expect(tree.nodes).toBe(nodes);
    expect(tree.expanded).toBe(expanded);
    expect(tree.renaming).toBe(`${rootPath}/file.txt`);
    expect(mocks.changed).toBeNull();

    let resolve!: (value: unknown[]) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => root.render(<Probe active />));
    expect(tree.nodes).toBe(nodes);
    expect(tree.renaming).toBe(`${rootPath}/file.txt`);
    expect(mocks.changed).not.toBeNull();
    await act(async () => root.render(<Probe active={false} />));
    await act(async () => resolve([]));
    expect(tree.nodes).toBe(nodes);

    await act(async () => root.render(<Probe active />));
    await act(async () => tree.beginCreate(rootPath, "file"));
    const pending = tree.pendingCreate;
    for (const active of [false, true]) {
      await act(async () => root.render(<Probe active={active} />));
      expect(tree.pendingCreate).toBe(pending);
      expect(tree.expanded).toBe(expanded);
    }
    await act(async () => root.render(<Probe active path="/other-root" />));
    expect(tree.pendingCreate).toBeNull();
    expect(tree.renaming).toBeNull();
    expect(tree.expanded.size).toBe(0);
    await act(async () => root.render(<Probe active />));
    expect([...tree.expanded]).toEqual([`${rootPath}/src`]);
    expect(tree.nodes[`${rootPath}/src`]?.status).toBe("loaded");
    const reads = mocks.invoke.mock.calls.length;
    await act(async () => root.render(<Probe active path={null} />));
    expect(tree.nodes).toEqual({});
    expect(tree.expanded.size).toBe(0);
    expect(mocks.invoke).toHaveBeenCalledTimes(reads);
  } finally {
    await act(async () => root.unmount());
  }
  for (const { value: release } of mocks.retainWatch.mock.results) {
    expect(release).toHaveBeenCalledTimes(1);
  }
});

it("replays changes received during a directory read and stops observing when hidden", async () => {
  let resolve!: (entries: unknown[]) => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mocks.invoke.mockResolvedValue([{ name: "new.md", kind: "file" }]);
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe({ active }: { active: boolean }) {
    const tree = useFileTree("/change-sync-test", { active });
    return <span>{JSON.stringify(tree)}</span>;
  }
  try {
    await act(async () => root.render(<Probe active />));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      mocks.changed?.(["/change-sync-test/new.md"]);
      mocks.changed?.(["/change-sync-test/new.md"]);
      resolve([]);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("new.md");
    await act(async () => root.render(<Probe active={false} />));
    expect(mocks.changed).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it("读取期间切换显示偏好，旧结果只进入原偏好的缓存并串行补查", async () => {
  const initial = usePreferencesStore.getState().showHidden;
  const path = "/options-switch-test";
  const finishes: ((entries: unknown[]) => void)[] = [];
  mocks.invoke.mockImplementation(
    () => new Promise((resolve) => finishes.push(resolve)),
  );
  const root = createRoot(document.createElement("div"));
  let tree!: ReturnType<typeof useFileTree>;
  function Probe() {
    tree = useFileTree(path);
    return null;
  }
  const cacheOptions = {
    workspace: currentWorkspaceEnv(),
    path,
    gitDecorations: usePreferencesStore.getState().explorerGitDecorations,
  };
  try {
    await act(async () => root.render(<Probe />));
    await act(async () =>
      usePreferencesStore.setState({ showHidden: !initial }),
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    const oldEntries = [{ name: "old.txt", kind: "file" }];
    await act(async () => finishes[0](oldEntries));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(tree.nodes[path]?.status).toBe("loading");
    expect(
      readCachedDirectory({ ...cacheOptions, showHidden: initial })?.entries,
    ).toEqual(oldEntries);
    expect(
      readCachedDirectory({ ...cacheOptions, showHidden: !initial }),
    ).toBeNull();
    const entries = [{ name: "current.txt", kind: "file" }];
    await act(async () => finishes[1](entries));
    expect(tree.nodes[path]).toEqual({ status: "loaded", entries });
    expect(
      readCachedDirectory({ ...cacheOptions, showHidden: !initial })?.entries,
    ).toEqual(entries);
  } finally {
    await act(async () => root.unmount());
    usePreferencesStore.setState({ showHidden: initial });
  }
});

it("keeps an ongoing deletion owned by the tree while the sidebar is hidden", async () => {
  let finishDelete!: () => void;
  mocks.invoke.mockImplementation((command) =>
    command === "fs_delete"
      ? new Promise<void>((resolve) => {
          finishDelete = resolve;
        })
      : Promise.resolve([{ name: "file.txt", kind: "file" }]),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  let tree!: ReturnType<typeof useFileTree>;
  function Probe({ active }: { active: boolean }) {
    tree = useFileTree("/deletion-switch-test", { active });
    return null;
  }
  try {
    await act(async () => root.render(<Probe active />));
    let deletion!: ReturnType<typeof tree.deletePath>;
    await act(async () => {
      deletion = tree.deletePath("/deletion-switch-test/file.txt");
    });
    await act(async () => root.render(<Probe active={false} />));
    expect(tree.deletingPaths.has("/deletion-switch-test/file.txt")).toBe(true);
    expect(await tree.deletePath("/deletion-switch-test/file.txt")).toEqual({
      kind: "already-deleting",
    });
    await act(async () => {
      finishDelete();
      expect(await deletion).toEqual({ kind: "deleted" });
    });
    expect(tree.deletingPaths.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});
