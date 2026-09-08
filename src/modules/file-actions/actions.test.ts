import {
  resolveFileReference,
  copyFileContent,
} from "@/modules/file-actions/actions";
import { parseFileReference } from "@/modules/file-actions/references";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copy: vi.fn(),
  env: { kind: "local" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.env,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { clipboard: { writeText: mocks.copy } });
});
describe("file reference operations", () => {
  it("recognizes a directory symlink without replacing the displayed path", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ kind: "symlink" })
      .mockResolvedValueOnce("/actual/folder")
      .mockResolvedValueOnce({ kind: "dir" });
    expect(await resolveFileReference(reference("/tmp/link"))).toEqual({
      path: "/tmp/link",
      isDir: true,
      line: undefined,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("fs_stat", {
      path: "/actual/folder",
      workspace: mocks.env,
    });
  });
  it("uses the literal POSIX filename before interpreting its colon as a line", async () => {
    mocks.invoke.mockResolvedValue({ kind: "file" });
    expect(await resolveFileReference(reference("/tmp/file:12"))).toEqual({
      path: "/tmp/file:12",
      isDir: false,
    });
  });
  it("resolves line locations and drops line numbers for directories", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ kind: "dir" });
    expect(await resolveFileReference(reference("/tmp/folder:12"))).toEqual({
      path: "/tmp/folder",
      isDir: true,
      line: undefined,
    });
  });
  it("does not turn missing file references into new files", async () => {
    mocks.invoke.mockRejectedValue(new Error("missing"));
    await expect(
      resolveFileReference(reference("D:/missing:12")),
    ).rejects.toThrow("missing");
    expect(mocks.invoke.mock.calls.map((call) => call[0])).toEqual(["fs_stat"]);
  });
  it.each(["binary", "toolarge"])(
    "refuses %s content without forcing a read",
    async (kind) => {
      mocks.invoke.mockResolvedValue({ kind });
      await expect(copyFileContent("/tmp/file")).rejects.toThrow(kind);
      expect(mocks.invoke).toHaveBeenCalledWith("fs_read_file", {
        path: "/tmp/file",
        workspace: mocks.env,
        force: false,
      });
      expect(mocks.copy).not.toHaveBeenCalled();
    },
  );
  it("copies complete disk text", async () => {
    mocks.invoke.mockResolvedValue({ kind: "text", content: "a\r\nb\r\n" });
    await copyFileContent("/tmp/file");
    expect(mocks.copy).toHaveBeenCalledWith("a\r\nb\r\n");
  });
  it.each([
    "relative.ts:1",
    "https://example.com:12",
    "javascript:alert(1)",
    "//example.com/file",
    "D:relative",
    "/tmp/\0file",
  ])("does not classify %s as a file reference", (value) => {
    expect(parseFileReference(value)).toBeNull();
  });
});

function reference(path: string) {
  const parsed = parseFileReference(path);
  if (!parsed) throw new Error("invalid test reference");
  return parsed;
}
