import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notifyDocumentSaved: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/lsp", () => ({
  notifyDocumentSaved: mocks.notifyDocumentSaved,
}));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning } }));

import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  discardSharedDocumentModel,
  documentResourceKey,
  getSharedDocumentModel,
  resetSharedDocumentModelsForTests,
} from "./documentModel";

const local = { kind: "local" } satisfies WorkspaceEnv;

describe("shared document model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({
      editorAutoSave: false,
      editorAutoSaveDelay: 1000,
    });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "fs_read_file") {
        return { kind: "text", content: "one\n", size: 4, mtime: 1 };
      }
      if (command === "fs_stat") return { kind: "file", size: 4, mtime: 1 };
      if (command === "fs_write_file") return 2;
      throw new Error(`unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSharedDocumentModelsForTests();
  });

  it("keys all views by workspace and normalized path", () => {
    const first = getSharedDocumentModel(local, "C:\\work\\file.ts");
    const second = getSharedDocumentModel(local, "c:/work/file.ts");
    const remote = getSharedDocumentModel(
      { kind: "ssh", profileId: "dev" },
      "c:/work/file.ts",
    );

    expect(second).toBe(first);
    expect(remote).not.toBe(first);
    expect(documentResourceKey(local, "C:\\work\\file.ts")).toBe(
      documentResourceKey(local, "c:/work/file.ts"),
    );
  });

  it("publishes one buffer and dirty state to every subscribed view", async () => {
    const first = getSharedDocumentModel(local, "C:/work/file.ts");
    const second = getSharedDocumentModel(local, "C:/work/file.ts");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = first.subscribe(firstListener);
    const unsubscribeSecond = second.subscribe(secondListener);

    await vi.waitFor(() =>
      expect(first.getSnapshot().doc.status).toBe("ready"),
    );
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "fs_read_file"),
    ).toHaveLength(1);
    first.onChange("two\n");

    expect(second.getSnapshot()).toMatchObject({
      dirty: true,
      doc: { status: "ready", content: "two\n" },
    });
    expect(firstListener).toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalled();

    firstListener.mockClear();
    secondListener.mockClear();
    second.onChange("two\n");
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).not.toHaveBeenCalled();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("coalesces reloads from multiple views and never reloads over dirty text", async () => {
    const first = getSharedDocumentModel(local, "C:/work/file.ts");
    const second = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});
    await vi.waitFor(() =>
      expect(first.getSnapshot().doc.status).toBe("ready"),
    );

    expect(first.reload()).toBe(true);
    expect(second.reload()).toBe(true);
    await vi.waitFor(() =>
      expect(
        mocks.invoke.mock.calls.filter(
          ([command]) => command === "fs_read_file",
        ),
      ).toHaveLength(2),
    );

    first.onChange("dirty\n");
    expect(second.reload()).toBe(false);
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "fs_read_file"),
    ).toHaveLength(2);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("coalesces concurrent saves and clears dirty for every view", async () => {
    const first = getSharedDocumentModel(local, "C:/work/file.ts");
    const second = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribeFirst = first.subscribe(() => {});
    const unsubscribeSecond = second.subscribe(() => {});
    await vi.waitFor(() =>
      expect(first.getSnapshot().doc.status).toBe("ready"),
    );
    first.onChange("shared\n");

    const [savedByFirst, savedBySecond] = await Promise.all([
      first.save(),
      second.save(),
    ]);

    expect(savedByFirst).toBe(true);
    expect(savedBySecond).toBe(true);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "fs_write_file",
      ),
    ).toHaveLength(1);
    expect(second.getSnapshot().dirty).toBe(false);
    expect(mocks.notifyDocumentSaved).toHaveBeenCalledOnce();

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("queues the latest buffer when editing continues during a save", async () => {
    const firstWrite = {
      release: null as ((mtime: number) => void) | null,
    };
    let diskMtime = 1;
    let diskSize = 4;
    let writeCount = 0;
    mocks.invoke.mockImplementation(
      async (command: string, args?: { content?: string }) => {
        if (command === "fs_read_file") {
          return { kind: "text", content: "one\n", size: 4, mtime: 1 };
        }
        if (command === "fs_stat") {
          return { kind: "file", size: diskSize, mtime: diskMtime };
        }
        if (command === "fs_write_file") {
          writeCount += 1;
          if (writeCount === 1) {
            diskMtime = await new Promise<number>((resolve) => {
              firstWrite.release = resolve;
            });
          } else {
            diskMtime += 1;
          }
          diskSize = new TextEncoder().encode(args?.content ?? "").byteLength;
          return diskMtime;
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    const model = getSharedDocumentModel(local, "C:/work/file.ts");
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    model.onChange("first edit\n");
    const firstSave = model.save();
    await vi.waitFor(() => expect(firstWrite.release).not.toBeNull());
    model.onChange("second edit\n");
    const secondSave = model.save();
    firstWrite.release?.(2);

    await expect(firstSave).resolves.toBe(true);
    await expect(secondSave).resolves.toBe(true);
    expect(writeCount).toBe(2);
    expect(model.getSnapshot().dirty).toBe(false);
    unsubscribe();
  });

  it("retains an orphaned dirty buffer until it is explicitly discarded", async () => {
    const path = "C:/work/file.ts";
    const model = getSharedDocumentModel(local, path);
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );
    model.onChange("unsaved\n");

    vi.useFakeTimers();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSharedDocumentModel(local, path)).toBe(model);
    expect(model.getSnapshot().dirty).toBe(true);

    discardSharedDocumentModel(local, path);
    expect(getSharedDocumentModel(local, path)).not.toBe(model);
  });

  it("releases an orphaned clean buffer after the grace period", async () => {
    const path = "C:/work/file.ts";
    const model = getSharedDocumentModel(local, path);
    const unsubscribe = model.subscribe(() => {});
    await vi.waitFor(() =>
      expect(model.getSnapshot().doc.status).toBe("ready"),
    );

    vi.useFakeTimers();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSharedDocumentModel(local, path)).not.toBe(model);
  });
});
