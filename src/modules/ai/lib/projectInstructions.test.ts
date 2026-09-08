import { beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "./native";
import { readWorkspaceInstructions } from "./projectInstructions";
vi.mock("./native", () => ({
  native: { readFile: vi.fn(), fileVersion: vi.fn() },
}));
const textFile = (content: string) => ({
  kind: "text" as const,
  content,
  size: content.length,
  mtime: 1,
  revision: "a".repeat(64),
});

describe("workspace instruction loading", () => {
  beforeEach(() => vi.resetAllMocks());
  it("loads relative files in configured order and silently skips only missing files", async () => {
    vi.mocked(native.readFile)
      .mockResolvedValueOnce(textFile("First"))
      .mockRejectedValueOnce("localized missing error")
      .mockResolvedValueOnce(textFile("Last"));
    vi.mocked(native.fileVersion).mockResolvedValue(null);
    expect(
      await readWorkspaceInstructions("D:/workspace", [
        "AGENTS.md",
        "missing.md",
        "docs/rules.md",
      ]),
    ).toEqual([
      { path: "AGENTS.md", content: "First" },
      { path: "docs/rules.md", content: "Last" },
    ]);
    expect(vi.mocked(native.readFile).mock.calls.map(([path]) => path)).toEqual(
      [
        "D:/workspace/AGENTS.md",
        "D:/workspace/missing.md",
        "D:/workspace/docs/rules.md",
      ],
    );
  });
  it("does not swallow permission or remote connection errors", async () => {
    vi.mocked(native.readFile).mockRejectedValue(
      new Error("permission denied"),
    );
    vi.mocked(native.fileVersion).mockRejectedValue(
      new Error("permission denied"),
    );
    await expect(
      readWorkspaceInstructions("/workspace", ["AGENTS.md"]),
    ).rejects.toThrow("permission denied");
    vi.mocked(native.fileVersion).mockResolvedValue({ revision: "a" });
    await expect(
      readWorkspaceInstructions("/workspace", ["AGENTS.md"]),
    ).rejects.toThrow("permission denied");
  });
  it("keeps full text and rereads files whenever initialization requests them", async () => {
    const content = "a".repeat(32 * 1024 + 10);
    vi.mocked(native.readFile)
      .mockResolvedValueOnce(textFile(content))
      .mockResolvedValueOnce(textFile("Changed"));
    expect(
      (await readWorkspaceInstructions("/workspace", ["AGENTS.md"]))[0].content,
    ).toBe(content);
    expect(
      (await readWorkspaceInstructions("/workspace", ["AGENTS.md"]))[0].content,
    ).toBe("Changed");
    expect(native.fileVersion).not.toHaveBeenCalled();
  });
  it("loads nothing when the field is empty and rejects invalid paths before IO", async () => {
    expect(await readWorkspaceInstructions("/workspace", [])).toEqual([]);
    await expect(
      readWorkspaceInstructions("/workspace", ["../secret"]),
    ).rejects.toThrow();
    expect(native.readFile).not.toHaveBeenCalled();
  });
  it("rejects binary instructions instead of silently losing configured rules", async () => {
    vi.mocked(native.readFile).mockResolvedValue({
      kind: "binary",
      size: 5,
      mtime: 1,
    });
    await expect(
      readWorkspaceInstructions("/workspace", ["rules.bin"]),
    ).rejects.toThrow("not readable text");
  });
});
