import { expect, it, vi } from "vitest";
import { pathCompletions, quoteCompletionPath } from "./pathComplete";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([{ name: "My Folder", kind: "dir" }]),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

it("Windows 盘符反斜杠路径不拼接到 cwd，并整体引用空格路径", async () => {
  const result = await pathCompletions("C:\\Users\\My", "D:/project", true);
  expect(invoke).toHaveBeenCalledWith(
    "fs_read_dir",
    expect.objectContaining({ path: "C:/Users/" }),
  );
  expect(result?.[0].label).toBe("My Folder/");
  expect(quoteCompletionPath("C:/My Folder/a'b.txt", true)).toBe(
    "'C:/My Folder/a''b.txt'",
  );
  expect(quoteCompletionPath("/tmp/a'b", false)).toBe("'/tmp/a'\\''b'");
  expect(quoteCompletionPath("/tmp/a\\b", false)).toBe("'/tmp/a\\b'");
});
