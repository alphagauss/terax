// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    draftExternalAgentId: null,
    sessions: [],
    runLockSessionIds: {},
    live: { draftCwd: "/project" },
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
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

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
