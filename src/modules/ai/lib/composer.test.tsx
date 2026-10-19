// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCommandStore } from "../commands/store";
import { AiComposerProvider, useComposer } from "./composer";

const mocks = vi.hoisted(() => ({
  primary: true,
  storage: new Map<string, unknown>(),
  read: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  send: vi.fn(),
  state: {
    activeSessionId: "draft",
    draftSessionId: "draft",
    draftCwdOverride: null as { sessionId: string; cwd: string } | null,
    draftExternalAgentId: null,
    sessions: [],
    runLockSessionIds: {},
    live: {
      draftCwd: "/project",
      defaultDraftCwd: "/default/workspace" as string | null,
      draftProjectRoot: "/project" as string | null,
    },
    focusSignal: 0,
    pendingSelections: [],
    pendingFileAttachments: [],
    patchAgentMeta: vi.fn(),
  },
}));
vi.mock("@/modules/workspace-process", () => ({
  currentWorkspaceBootstrap: () => ({
    isPrimary: mocks.primary,
    environmentKey: "local",
  }),
  getWorkspaceValue: mocks.read,
  setWorkspaceValue: mocks.write,
  deleteWorkspaceValue: mocks.remove,
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: Object.assign(
    (select: (state: typeof mocks.state) => unknown) => select(mocks.state),
    {
      getState: () => mocks.state,
      setState: (patch: Partial<typeof mocks.state>) =>
        Object.assign(mocks.state, patch),
    },
  ),
  sessionMetadata: new Map(),
  getAgentMetaForSession: () => ({ status: "idle", pendingSteering: 0 }),
}));
vi.mock("@/modules/ai/store/chatRuntime", () => ({
  sendChatMessage: mocks.send,
}));
vi.mock("@/modules/ai/external-agents/runtime", () => ({
  parseExternalAgentBinding: () => null,
}));
vi.mock("@/modules/ai/hooks/useWhisperRecording", () => ({
  useWhisperRecording: () => ({}),
}));
vi.mock("@/modules/ai/store/snippetsStore", () => ({
  useSnippetsStore: { getState: () => ({ snippets: [] }) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
vi.mock("@/lib/errors", () => ({ reportError: vi.fn() }));

const key = "ai:composerDraft";
const image = {
  id: "image",
  kind: "image",
  name: "clipboard.png",
  size: 3,
  mediaType: "image/png",
  url: "data:image/png;base64,YWJj",
};
const snippet = {
  id: "snippet",
  handle: "test",
  name: "Test",
  description: "",
  content: "saved snippet",
};
const draft = {
  value: "  unfinished\n",
  files: [
    image,
    {
      id: "selection",
      kind: "selection",
      source: "terminal",
      text: "selected output",
    },
  ],
  pickedSnippets: [snippet],
};
let composer: ReturnType<typeof useComposer>;
let root: ReturnType<typeof createRoot>;
const env = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
function Harness() {
  composer = useComposer();
  return null;
}
function mount() {
  root = createRoot(document.createElement("div"));
  render();
}
function render() {
  act(() =>
    root.render(
      <AiComposerProvider openFileGroups={[]}>
        <Harness />
      </AiComposerProvider>,
    ),
  );
}
beforeEach(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.primary = true;
  mocks.state.activeSessionId = "draft";
  mocks.state.draftSessionId = "draft";
  mocks.state.draftCwdOverride = null;
  mocks.state.live.draftProjectRoot = "/project";
  mocks.state.live.draftCwd = "/project";
  mocks.state.live.defaultDraftCwd = "/default/workspace";
  mocks.storage.clear();
  mocks.read.mockImplementation((key: string) => mocks.storage.get(key));
  mocks.write.mockImplementation(async (key: string, value: unknown) => {
    mocks.storage.set(key, structuredClone(value));
  });
  mocks.remove.mockImplementation(async (key: string) => {
    mocks.storage.delete(key);
  });
  mocks.send.mockResolvedValue(true);
});
afterEach(() => {
  act(() => root.unmount());
  env.IS_REACT_ACT_ENVIRONMENT = false;
});

it("默认目录准备前及项目已是默认 workspace 时隐藏重置入口", () => {
  mocks.state.live.defaultDraftCwd = null;
  mount();
  expect(composer.workingDirectoryAction).toBeNull();
  mocks.state.live.defaultDraftCwd = "/default/workspace";
  mocks.state.live.draftCwd = "/default/workspace";
  mocks.state.live.draftProjectRoot = "/default/workspace";
  render();
  expect(composer.workingDirectoryAction).toBeNull();
  act(() => composer.changeWorkingDirectory());
  expect(mocks.state.draftCwdOverride).toBeNull();
});

it("按实际目录切换重置与恢复跟随，历史会话和无项目时不提供操作", async () => {
  mount();
  expect(composer.workingDirectoryAction).toBe("reset");
  await act(async () => composer.changeWorkingDirectory());
  render();
  expect(composer.workingDirectory).toBe("/default/workspace");
  expect(composer.workingDirectoryAction).toBe("restore");
  await act(async () => composer.changeWorkingDirectory());
  render();
  expect(composer.workingDirectory).toBe("/project");
  expect(composer.workingDirectoryAction).toBe("reset");
  expect(mocks.state.draftCwdOverride).toBeNull();
  mocks.state.draftCwdOverride = { sessionId: "draft", cwd: "/project" };
  render();
  expect(composer.workingDirectoryAction).toBe("reset");
  mocks.state.activeSessionId = "saved";
  render();
  expect(composer.workingDirectoryAction).toBeNull();
  mocks.state.activeSessionId = "draft";
  mocks.state.live.draftProjectRoot = null;
  render();
  expect(composer.workingDirectoryAction).toBeNull();
});

it("主窗口重挂载恢复原始正文、图片、选区和 Snippet，移除图片覆盖缓存", () => {
  mocks.storage.set(key, structuredClone(draft));
  mount();
  expect(composer.value).toBe(draft.value);
  expect(composer.files).toEqual(draft.files);
  expect(composer.pickedSnippets).toEqual(draft.pickedSnippets);
  act(() => {
    composer.setValue("edited");
    composer.removeFile("image");
  });
  act(() => root.unmount());
  mount();
  expect(composer.value).toBe("edited");
  expect(composer.files).toEqual([draft.files[1]]);
  expect(JSON.stringify(mocks.storage.get(key))).not.toContain(image.url);
});

it("临时窗口复用自身 Store，手动清空输入删除缓存", () => {
  mocks.primary = false;
  mount();
  expect(composer.value).toBe("");
  expect(composer.files).toEqual([]);
  act(() => composer.setValue("temporary"));
  expect(mocks.storage.get(key)).toEqual({
    value: "temporary",
    files: [],
    pickedSnippets: [],
  });
  act(() => composer.setValue(""));
  expect(mocks.storage.has(key)).toBe(false);
});

it("接收失败保留草稿，成功发送后删除缓存", async () => {
  mocks.storage.set(key, structuredClone(draft));
  mount();
  mocks.send.mockResolvedValueOnce(false);
  await act(async () => composer.submit());
  expect(mocks.storage.get(key)).toEqual(draft);
  await act(async () => composer.submit());
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(composer.value).toBe("");
  expect(composer.files).toEqual([]);
  expect(composer.pickedSnippets).toEqual([]);
  expect(mocks.storage.has(key)).toBe(false);
});

it("发送确认期间的新输入继续保存", async () => {
  mocks.storage.set(key, structuredClone(draft));
  mount();
  let accept!: (value: boolean) => void;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      }),
  );
  await act(async () => composer.submit());
  act(() => composer.setValue("next message"));
  await act(async () => accept(true));
  expect(mocks.storage.get(key)).toEqual({
    value: "next message",
    files: [],
    pickedSnippets: [],
  });
});

it("选择命令提交明确文本，执行期间保留可编辑草稿并禁止再次提交", async () => {
  mount();
  act(() => composer.setValue("/co"));
  await act(async () => {
    composer.setValue("/compact");
    composer.submit("/compact");
  });
  expect(mocks.send.mock.calls[0][1].parts).toEqual([
    { type: "text", text: "/compact" },
  ]);
  expect(composer.value).toBe("");
  act(() =>
    useCommandStore.setState({ active: { draft: new AbortController() } }),
  );
  act(() => composer.setValue("next draft"));
  expect(composer.isBusy).toBe(true);
  expect(composer.canSend).toBe(false);
  await act(async () => composer.submit());
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(composer.value).toBe("next draft");
  act(() => useCommandStore.setState({ active: {} }));
});

it("命令选择遇到已有附件时保留正文和附件，不提交无效请求", async () => {
  mocks.storage.set(key, draft);
  mount();
  await act(async () => {
    composer.setValue("/compact");
    composer.submit("/compact");
  });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(composer.value).toBe("/compact");
  expect(composer.files).toEqual(draft.files);
  expect(composer.pickedSnippets).toEqual([snippet]);
});
