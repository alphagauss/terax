/** 本文件验证共享 watcher 的引用计数和文件事件路由。 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { useRemoteRuntimeStore } from "@/modules/remote";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown) => undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: vi.fn(
      async (
        event: string,
        listener: (event: { payload: unknown }) => void,
      ) => {
        mocks.listeners.set(event, listener);
        return vi.fn();
      },
    ),
  }),
}));

import {
  parentDirectory,
  retainDirectoryWatch,
  subscribeActiveFile,
  subscribeFileSystemChanges,
  subscribeWorkspaceResume,
} from "./changeHub";

const workspace = { kind: "local" } as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe("workspace change hub", () => {
  it("revalidates once when the remote runtime reconnects, not on ordinary snapshots", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceResume(listener);
    const store = useRemoteRuntimeStore.getState();
    store.applySnapshot({
      phase: "reconnecting",
      version: 1,
      profileId: "ssh",
    });
    const connected = {
      phase: "connected",
      version: 2,
      epoch: 1,
      profileId: "ssh",
      home: "/home",
    } as const;
    store.applySnapshot(connected);
    store.applySnapshot({ ...connected, version: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("preserves the absolute drive root for files directly under it", () => {
    expect(parentDirectory("C:/readme.md")).toBe("C:/");
    expect(parentDirectory("C:\\readme.md")).toBe("C:\\");
  });

  it("normalizes native separators for directory subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFileSystemChanges(workspace, listener);
    mocks.listeners.get("fs:changed")?.({
      payload: { paths: ["C:\\work\\readme.md"] },
    });
    expect(listener).toHaveBeenCalledWith(["C:/work/readme.md"]);
    unsubscribe();
  });

  it("shares one native directory watch until the final owner releases it", async () => {
    const releaseFirst = retainDirectoryWatch(workspace, "C:/work");
    const releaseSecond = retainDirectoryWatch(workspace, "C:/work");

    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("fs_watch_add", {
        paths: ["C:/work"],
        workspace,
      }),
    );
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "fs_watch_add"),
    ).toHaveLength(1);

    releaseFirst();
    await Promise.resolve();
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_watch_remove",
      ),
    ).toHaveLength(0);

    releaseSecond();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("fs_watch_remove", {
        paths: ["C:/work"],
        workspace,
      }),
    );
  });

  it("routes a native path change directly to the active file", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveFile(
      workspace,
      "C:/work/readme.md",
      listener,
    );
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    listener.mockClear();

    mocks.listeners.get("fs:changed")?.({
      payload: { paths: ["C:/work/readme.md"] },
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.waitFor(() =>
      expect(
        mocks.invoke.mock.calls.some(
          ([command]) => command === "fs_watch_remove",
        ),
      ).toBe(true),
    );
  });
});
