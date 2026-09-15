// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnv } from "@/modules/workspace";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";

const mocks = vi.hoisted(() => ({
  env: { kind: "local" } as WorkspaceEnv,
  canonicalize: vi.fn(),
  authorize: vi.fn(),
  invoke: vi.fn(),
  picker: vi.fn(),
  error: vi.fn(),
  createWorkbench: vi.fn(),
  ready: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.env,
}));
vi.mock("@/modules/workspace-process", () => ({
  setWorkspaceValue: vi.fn(async () => {}),
  deleteWorkspaceValue: vi.fn(async () => {}),
}));
vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    canonicalize: mocks.canonicalize,
    workspaceAuthorize: mocks.authorize,
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.picker }));
vi.mock("@/i18n", () => ({ default: { t: mocks.t } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));

import {
  prepareSpaceDirectory,
  useSpaceDirectories,
} from "./useSpaceDirectories";
import { createDefaultSpace, useSpaces } from "./useSpaces";

let root: ReturnType<typeof createRoot> | null = null;
let directories: ReturnType<typeof useSpaceDirectories>;
function Harness() {
  directories = useSpaceDirectories(mocks.createWorkbench, mocks.ready);
  return null;
}
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.env = { kind: "local" };
  mocks.ready.mockResolvedValue("/home");
  mocks.canonicalize.mockImplementation(async (path: string) => path);
  mocks.invoke.mockResolvedValue({ kind: "dir" });
  mocks.authorize.mockResolvedValue("/authorized");
  useSpaces.setState({
    spaces: [createDefaultSpace()],
    activeId: DEFAULT_SPACE_ID,
  });
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe("Space directory actions", () => {
  it("opens Default selections in a new empty workbench and edits ordinary spaces in place", async () => {
    mocks.picker.mockResolvedValue("C:\\work\\project");
    await act(async () => directories.chooseDirectory(DEFAULT_SPACE_ID));
    const space = useSpaces.getState().spaces[1];
    expect(space).toMatchObject({
      root: "c:/work/project",
      name: "project",
      rootLocked: true,
    });
    expect(useSpaces.getState().activeId).toBe(space.id);
    expect(mocks.createWorkbench).toHaveBeenCalledExactlyOnceWith(space.id);
    expect(mocks.authorize).toHaveBeenCalledWith("C:/work/project");
    await act(async () => {
      await directories.openDirectory("/work/other", space.id);
    });
    expect(useSpaces.getState().spaces).toHaveLength(2);
    expect(useSpaces.getState().spaces[1]).toMatchObject({
      root: "/work/other",
      name: "other",
    });
    expect(mocks.createWorkbench).toHaveBeenCalledTimes(1);
  });

  it("does not create spaces for cancelled pickers, non-directories or denied authorization", async () => {
    mocks.picker.mockResolvedValue(null);
    await act(async () => directories.chooseDirectory(null));
    mocks.invoke.mockResolvedValue({ kind: "file" });
    await act(async () => {
      await directories.openDirectory("/file", null);
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue({ kind: "dir" });
    mocks.authorize.mockRejectedValue(new Error("Access denied"));
    await act(async () => {
      await directories.openDirectory("/denied", null);
    });
    expect(useSpaces.getState().spaces).toHaveLength(1);
    expect(mocks.createWorkbench).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });

  it("keeps asynchronous directory selection attached to the original space", async () => {
    const a = useSpaces.getState().create({ root: "/a", name: "a" });
    const b = useSpaces.getState().create({ root: "/b", name: "b" });
    let finish: (path: string) => void = () => {};
    mocks.picker.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = directories.chooseDirectory(a.id);
    useSpaces.getState().setActive(b.id);
    finish("/chosen");
    await act(async () => pending);
    expect(useSpaces.getState().spaces[1].root).toBe("/chosen");
    expect(useSpaces.getState().spaces[2].root).toBe("/b");
    expect(useSpaces.getState().activeId).toBe(b.id);
    const deleted = directories.chooseDirectory(a.id);
    useSpaces.getState().remove(a.id);
    finish("/late");
    await act(async () => deleted);
    expect(useSpaces.getState().spaces.map((space) => space.root)).toEqual([
      null,
      "/b",
    ]);
  });

  it.each<WorkspaceEnv>([
    { kind: "wsl", distro: "Ubuntu" },
    { kind: "ssh", profileId: "server" },
  ])("uses a cancellable environment dialog for $kind", async (env) => {
    mocks.env = env;
    await act(async () => directories.chooseDirectory(null));
    expect(mocks.picker).not.toHaveBeenCalled();
    expect(directories.request).not.toBeNull();
    let finish: (path: string) => void = () => {};
    mocks.canonicalize.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    let pending: Promise<void>;
    await act(async () => {
      pending = directories.submitDialog("/project");
    });
    await act(async () => directories.closeDialog());
    finish("/project");
    await act(async () => pending);
    expect(useSpaces.getState().spaces).toHaveLength(1);
  });

  it("converts WSL canonical UNC paths back to Linux before persisting or authorizing", async () => {
    mocks.env = { kind: "wsl", distro: "Ubuntu" };
    mocks.canonicalize.mockResolvedValue(
      "//wsl.localhost/Ubuntu/home/me/project",
    );
    expect(await prepareSpaceDirectory("/home/me/project")).toBe(
      "/home/me/project",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("fs_stat", {
      path: "/home/me/project",
      workspace: mocks.env,
    });
    expect(mocks.authorize).toHaveBeenCalledWith("/home/me/project");
  });
});
