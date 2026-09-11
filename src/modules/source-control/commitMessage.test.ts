/** 验证真实生成任务的配置快照、修复边界和仓库草稿隔离，只替换 SDK 与 Git IO。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderConnection } from "@/modules/ai/providerRegistry";
import type { TextGenerationConfiguration } from "@/modules/ai/lib/textGeneration";
import {
  commitMessageStore,
  generateRepositoryCommitMessage,
  setCommitMessageDraft,
} from "./commitMessage";

const io = vi.hoisted(() => ({
  diff: vi.fn(),
  build: vi.fn(),
  generate: vi.fn(),
}));
vi.mock("@/modules/ai/lib/native", () => ({ native: { gitDiff: io.diff } }));
vi.mock("@/modules/ai/lib/providerRuntime", () => ({
  buildLanguageModel: io.build,
}));
vi.mock("ai", () => ({ generateText: io.generate }));

const entries = [
  { path: "a.ts", statusCode: "M", originalPath: null, untracked: false },
];
function configuration(): TextGenerationConfiguration {
  return {
    connection: createProviderConnection({
      provider: "deepseek",
      instanceId: "builtin:deepseek",
      credentialValue: "key-one",
    }),
    modelId: "model-one",
    parameters: [
      { target: "standard", path: "temperature", value: 0.1 },
      { target: "standard", path: "max_tokens", value: 256 },
    ],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  commitMessageStore.setState({}, true);
  io.diff.mockResolvedValue({ diffText: "staged diff" });
  io.build.mockResolvedValue({ id: "sdk-model" });
});

describe("commit message tasks", () => {
  it("freezes configuration before Git IO and reuses it for repair, then reads the next task's configuration", async () => {
    let finishDiff!: (value: { diffText: string; truncated: boolean }) => void;
    io.diff.mockReturnValueOnce(
      new Promise((resolve) => {
        finishDiff = resolve;
      }),
    );
    io.generate
      .mockResolvedValueOnce({ text: "feat(" })
      .mockResolvedValueOnce({ text: '"fix(core): handle staged changes"' })
      .mockResolvedValueOnce({ text: "chore: update files" });
    const config = configuration();
    const staged = structuredClone(entries);
    const task = generateRepositoryCommitMessage("/repo", staged, config);
    config.modelId = "model-two";
    config.parameters = [
      { target: "standard", path: "temperature", value: 0.9 },
    ];
    config.connection = createProviderConnection({
      provider: "deepseek",
      instanceId: "builtin:deepseek",
      credentialValue: "key-two",
    });
    staged[0].path = "changed-after-start.ts";
    finishDiff({ diffText: "staged diff", truncated: true });
    await task;
    expect(io.diff).toHaveBeenCalledWith("/repo", null, "index");
    expect(io.generate.mock.calls[0][0].prompt).toContain(
      "diff below was truncated",
    );
    expect(io.build).toHaveBeenCalledTimes(1);
    expect(io.build.mock.calls[0][1]).toBe("model-one");
    expect(io.build.mock.calls[0][0].credential.value).toBe("key-one");
    for (const [request] of io.generate.mock.calls) {
      expect(request).toMatchObject({ temperature: 0.1, maxOutputTokens: 256 });
      expect(request.prompt).toContain("a.ts");
      expect(request.prompt).not.toContain("changed-after-start.ts");
    }
    expect(commitMessageStore.getState()["/repo"]).toMatchObject({
      text: "fix(core): handle staged changes",
      running: false,
      error: null,
    });
    await generateRepositoryCommitMessage("/repo", entries, config);
    expect(io.build.mock.calls[1][1]).toBe("model-two");
    expect(io.generate.mock.calls[2][0]).toMatchObject({
      temperature: 0.9,
    });
    expect(io.generate.mock.calls[2][0]).not.toHaveProperty("maxOutputTokens");
  });

  it("keeps repository tasks independent and never overwrites a user's newer draft", async () => {
    const finishes: ((result: { text: string }) => void)[] = [];
    io.generate.mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    const a = generateRepositoryCommitMessage("/a", entries, configuration());
    const b = generateRepositoryCommitMessage("/b", entries, configuration());
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    await generateRepositoryCommitMessage("/a", entries, configuration());
    expect(io.diff).toHaveBeenCalledTimes(2);
    setCommitMessageDraft("/a", "my own draft");
    finishes[0]({ text: "fix: generated for a" });
    finishes[1]({ text: "fix: generated for b" });
    await Promise.all([a, b]);
    expect(commitMessageStore.getState()["/a"].text).toBe("my own draft");
    expect(commitMessageStore.getState()["/b"].text).toBe(
      "fix: generated for b",
    );
    expect(commitMessageStore.getState()["/a"].running).toBe(false);
  });

  it("repairs at most once and preserves the draft on invalid output or request failure", async () => {
    setCommitMessageDraft("/repo", "existing draft");
    io.generate.mockResolvedValue({ text: "invalid" });
    await generateRepositoryCommitMessage("/repo", entries, configuration());
    expect(io.generate).toHaveBeenCalledTimes(2);
    expect(commitMessageStore.getState()["/repo"]).toMatchObject({
      text: "existing draft",
      running: false,
      error: { kind: "invalid" },
    });
    io.generate.mockRejectedValueOnce(new Error("network failed"));
    await generateRepositoryCommitMessage("/repo", entries, configuration());
    expect(io.generate).toHaveBeenCalledTimes(3);
    expect(commitMessageStore.getState()["/repo"]).toMatchObject({
      text: "existing draft",
      running: false,
      error: { kind: "request", message: "network failed" },
    });
  });
});
