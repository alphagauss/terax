// @vitest-environment happy-dom
/** 生成入口不依赖活动聊天模型与忙碌状态，按仓库读取独立草稿。 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSourceControlPanel } from "./useSourceControlPanel";
import type { RepositoryController } from "./useRepositoryController";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { commitMessageStore, setCommitMessageDraft } from "./commitMessage";

const io = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("./commitMessage", async (original) => ({
  ...(await original<typeof import("./commitMessage")>()),
  generateRepositoryCommitMessage: io.generate,
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("can generate with its own model while chat is running and keeps drafts scoped to the repository", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const ref = { providerId: "builtin:ollama", modelId: "commit-model" };
  const savedPreferences = usePreferencesStore.getState();
  const savedChat = useChatStore.getState();
  usePreferencesStore.setState({
    ...DEFAULT_PREFERENCES,
    modelUsages: {
      ...DEFAULT_PREFERENCES.modelUsages,
      commitMessage: { model: ref, parameterSelections: {} },
    },
    providerModels: {
      [ref.providerId]: [
        { id: ref.modelId, source: "manual", contextWindow: 128000 },
      ],
    },
  });
  useChatStore.setState({
    selectedModel: null,
    activeSessionId: "busy-chat",
    agentMetaBySession: { "busy-chat": { status: "streaming" } as never },
  });
  commitMessageStore.setState({}, true);
  io.generate.mockResolvedValue(undefined);
  const controller: RepositoryController = {
    repo: { repoRoot: "/a", branch: "main", upstream: null, isDetached: false },
    status: {
      repoRoot: "/a",
      branch: "main",
      headSha: "head",
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: [
        {
          path: "a.ts",
          originalPath: null,
          indexStatus: "M",
          worktreeStatus: " ",
          staged: true,
          unstaged: false,
          untracked: false,
          statusLabel: "Modified",
        },
      ],
    },
    diffStats: null,
    changedCount: 1,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    isRefreshing: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    revision: 1,
    graphRevision: null,
    refresh: vi.fn(),
    runRemoteAction: vi.fn(),
  };
  let panel!: ReturnType<typeof useSourceControlPanel>;
  function View({ value }: { value: RepositoryController }) {
    panel = useSourceControlPanel(true, value, null);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<View value={controller} />));
    expect(panel.canGenerateCommitMessage).toBe(true);
    await act(async () => panel.generateCommitMessage());
    expect(io.generate).toHaveBeenCalledWith(
      "/a",
      expect.any(Array),
      expect.objectContaining({ modelId: "commit-model" }),
    );
    await act(async () => panel.setCommitMessage("draft a"));
    await act(async () =>
      root.render(
        <View
          value={{
            ...controller,
            repo: {
              repoRoot: "/b",
              branch: "main",
              upstream: null,
              isDetached: false,
            },
          }}
        />,
      ),
    );
    expect(panel.commitMessage).toBe("");
    await act(async () => setCommitMessageDraft("/a", "late result for a"));
    expect(panel.commitMessage).toBe("");
  } finally {
    await act(async () => root.unmount());
    usePreferencesStore.setState(savedPreferences);
    useChatStore.setState(savedChat);
    commitMessageStore.setState({}, true);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
