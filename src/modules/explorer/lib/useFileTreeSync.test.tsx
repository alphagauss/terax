// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  changed: null as ((paths: string[]) => void) | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/filesystem", () => ({
  retainDirectoryWatch: () => () => {},
  subscribeWorkspaceResume: () => () => {},
  subscribeFileSystemChanges: (
    _workspace: unknown,
    listener: (paths: string[]) => void,
  ) => {
    mocks.changed = listener;
    return () => {
      mocks.changed = null;
    };
  },
}));

import { useFileTree } from "./useFileTree";

it("replays changes received during a directory read and stops observing when hidden", async () => {
  let resolve!: (entries: unknown[]) => void;
  mocks.invoke.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  mocks.invoke.mockResolvedValue([{ name: "new.md", kind: "file" }]);
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe({ active }: { active: boolean }) {
    const tree = useFileTree("/change-sync-test", { active });
    return <span>{JSON.stringify(tree)}</span>;
  }
  try {
    await act(async () => root.render(<Probe active />));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      mocks.changed?.(["/change-sync-test/new.md"]);
      mocks.changed?.(["/change-sync-test/new.md"]);
      resolve([]);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("new.md");
    await act(async () => root.render(<Probe active={false} />));
    expect(mocks.changed).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
