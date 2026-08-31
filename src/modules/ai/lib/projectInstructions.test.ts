/**
 * 本文件验证 AGENTS.md 的实时读取、缺失处理和完整内容返回行为。
 * 长指令测试用于防止重新引入静默截断。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "./native";
import { readAgentsMd } from "./projectInstructions";

vi.mock("./native", () => ({
  native: { readFile: vi.fn() },
}));

const readFileMock = vi.mocked(native.readFile);

describe("readAgentsMd", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("reads AGENTS.md from the session working directory", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "# Project instructions",
      size: 22,
      mtime: 1,
      revision: "a".repeat(64),
    });

    await expect(readAgentsMd("C:/work/project-available")).resolves.toBe(
      "# Project instructions",
    );
    expect(readFileMock).toHaveBeenCalledWith(
      "C:/work/project-available/AGENTS.md",
    );
  });

  it("returns null when AGENTS.md does not exist", async () => {
    readFileMock.mockRejectedValue(new Error("not found"));

    await expect(readAgentsMd("C:/work/project-missing")).resolves.toBeNull();
  });

  it("returns instructions larger than 32 KiB without truncation", async () => {
    const content = "a".repeat(32 * 1024 + 10);
    readFileMock.mockResolvedValue({
      kind: "text",
      content,
      size: content.length,
      mtime: 1,
      revision: "a".repeat(64),
    });

    const result = await readAgentsMd("C:/work/project-large");

    expect(result).toBe(content);
  });

  it("reads the file again for a newly created Chat runtime", async () => {
    readFileMock
      .mockResolvedValueOnce({
        kind: "text",
        content: "First instructions",
        size: 18,
        mtime: 1,
        revision: "a".repeat(64),
      })
      .mockResolvedValueOnce({
        kind: "text",
        content: "Updated instructions",
        size: 20,
        mtime: 2,
        revision: "b".repeat(64),
      });

    await expect(readAgentsMd("C:/work/project")).resolves.toBe(
      "First instructions",
    );
    await expect(readAgentsMd("C:/work/project")).resolves.toBe(
      "Updated instructions",
    );
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });
});
