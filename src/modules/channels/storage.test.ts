/** 检查点复用普通文件接口，缺失、损坏与 I/O 失败必须具有不同语义。 */
import { beforeEach, expect, it, vi } from "vitest";
import {
  loadCheckpoint,
  saveCheckpoint,
  removeConnection,
} from "@/modules/channels/storage";

const io = vi.hoisted(() => ({
  files: new Map<string, string>(),
  invoke: vi.fn(),
  sharedSet: vi.fn(),
  sharedDelete: vi.fn(),
}));
vi.mock("@/lib/nativeHost", () => ({ invokeNative: io.invoke }));
vi.mock("@/lib/sharedStore", () => ({
  setSharedStoreKey: io.sharedSet,
  deleteSharedStoreKey: io.sharedDelete,
  readSharedStore: vi.fn(),
}));
vi.mock("@/modules/settings/store", () => ({ deleteModelUsage: vi.fn() }));

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const checkpoint = {
  cursor: "cursor",
  cursorScope: "account",
  recentIds: ["message"],
  pendingIds: [],
};

beforeEach(() => {
  io.files.clear();
  io.sharedSet.mockClear();
  io.sharedDelete.mockClear();
  io.invoke
    .mockReset()
    .mockImplementation(
      async (command: string, args: Record<string, unknown>) => {
        const path = args.path as string;
        switch (command) {
          case "workspace_prepare_default_root":
            return "/state";
          case "fs_stat":
            return io.files.has(path) ? { kind: "file" } : null;
          case "fs_read_file":
            return { kind: "text", content: io.files.get(path) };
          case "fs_write_file":
            io.files.set(path, args.content as string);
            return 0;
          case "fs_delete":
            io.files.delete(path);
            return;
          default:
            throw new Error(`Unexpected command: ${command}`);
        }
      },
    );
});

it("writes complete per-connection JSON through the atomic file interface", async () => {
  expect(await loadCheckpoint(a)).toEqual({
    cursor: "",
    cursorScope: "",
    recentIds: [],
    pendingIds: [],
  });
  await saveCheckpoint(a, checkpoint);
  await saveCheckpoint(b, { ...checkpoint, cursor: "other" });
  expect(JSON.parse(io.files.get(`/state/${a}.json`) ?? "null")).toEqual(
    checkpoint,
  );
  expect(await loadCheckpoint(a)).toEqual(checkpoint);
  expect(io.sharedSet).not.toHaveBeenCalled();
  expect(io.invoke).toHaveBeenCalledWith("workspace_prepare_default_root", {
    appSubdir: "channels/state",
  });
  expect(io.invoke).toHaveBeenCalledWith("fs_stat", {
    path: `/state/${a}.json`,
    workspace: { kind: "local" },
    missingOk: true,
  });
  await removeConnection(a);
  await removeConnection(a);
  expect(io.files.has(`/state/${a}.json`)).toBe(false);
  expect(io.files.has(`/state/${b}.json`)).toBe(true);
});

it("reports corrupt checkpoints but permits their removal without parsing", async () => {
  io.files.set(`/state/${a}.json`, "broken json");
  await expect(loadCheckpoint(a)).rejects.toMatchObject({ issue: "storage" });
  await removeConnection(a);
  expect(io.files.size).toBe(0);
});

it("does not disguise stat errors or a directory as an absent checkpoint", async () => {
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "workspace_prepare_default_root") return "/state";
    throw new Error("permission denied");
  });
  await expect(loadCheckpoint(a)).rejects.toMatchObject({ issue: "storage" });
  io.invoke.mockImplementation(async (command: string) =>
    command === "workspace_prepare_default_root" ? "/state" : { kind: "dir" },
  );
  await expect(removeConnection(a)).rejects.toMatchObject({ issue: "storage" });
  expect(io.sharedDelete).not.toHaveBeenCalled();
  expect(
    io.invoke.mock.calls.some(([command]) => command === "fs_delete"),
  ).toBe(false);
});

it("rejects path injection before native access and propagates write failures", async () => {
  await expect(saveCheckpoint("../outside", checkpoint)).rejects.toMatchObject({
    issue: "storage",
  });
  expect(io.invoke).not.toHaveBeenCalled();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "workspace_prepare_default_root") return "/state";
    throw new Error("disk full");
  });
  await expect(saveCheckpoint(a, checkpoint)).rejects.toMatchObject({
    issue: "storage",
  });
});
