/**
 * 本文件验证 AGENTS.md 的读取、缺失处理、缓存入口和完整内容返回行为。
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

  it("reads AGENTS.md from the workspace root", async () => {
    readFileMock.mockResolvedValue({
      kind: "text",
      content: "# Project instructions",
      size: 22,
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

  it("does not read without a workspace root", async () => {
    await expect(readAgentsMd(null)).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns instructions larger than 32 KiB without truncation", async () => {
    const content = "a".repeat(32 * 1024 + 10);
    readFileMock.mockResolvedValue({
      kind: "text",
      content,
      size: content.length,
    });

    const result = await readAgentsMd("C:/work/project-large");

    expect(result).toBe(content);
  });
});
