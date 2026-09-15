import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPACE_ID } from "@/modules/workbench/types";

const writes = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock("@/modules/workspace-process", () => ({
  setWorkspaceValue: writes.save,
  deleteWorkspaceValue: writes.remove,
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
import { createDefaultSpace, normalizeSpaceRoot, useSpaces } from "./useSpaces";

beforeEach(() => {
  useSpaces.setState({
    spaces: [createDefaultSpace()],
    activeId: DEFAULT_SPACE_ID,
    hydrated: true,
  });
  vi.clearAllMocks();
});

describe("Space directory metadata", () => {
  it("keeps the saved root and name while unlocked, and renames only on a different relock root", () => {
    const space = useSpaces
      .getState()
      .create({ name: "Space 2", root: "/work/alpha" });
    const read = () =>
      useSpaces.getState().spaces.find((item) => item.id === space.id);
    useSpaces.getState().setRootLocked(space.id, false, "/work/beta");
    expect(read()).toMatchObject({
      root: "/work/alpha",
      name: "alpha",
      rootLocked: false,
    });
    useSpaces.getState().setRootLocked(space.id, true, "/work/alpha/");
    expect(read()).toMatchObject({
      root: "/work/alpha",
      name: "alpha",
      rootLocked: true,
    });
    useSpaces.getState().setRootLocked(space.id, false, null);
    useSpaces.getState().setRootLocked(space.id, true, "/work/beta");
    expect(read()).toMatchObject({
      root: "/work/beta",
      name: "beta",
      rootLocked: true,
    });
    expect(writes.save).toHaveBeenLastCalledWith(
      "spaces",
      useSpaces.getState().spaces,
    );
    useSpaces.getState().rename(space.id, "My project");
    useSpaces.getState().setRoot(space.id, "/work/gamma");
    expect(read()).toMatchObject({
      root: "/work/gamma",
      name: "My project",
      autoName: false,
    });
  });

  it("binds the first root but never overwrites a name edited before binding", () => {
    const space = useSpaces.getState().create({ name: "Space 2", root: null });
    expect(space).toMatchObject({
      root: null,
      rootLocked: true,
      autoName: true,
    });
    useSpaces.getState().rename(space.id, "Research");
    useSpaces.getState().setRoot(space.id, "/work/project");
    expect(useSpaces.getState().spaces[1]).toMatchObject({
      name: "Research",
      root: "/work/project",
    });
  });

  it("does not resurrect an old root when locking an empty following space", () => {
    const space = useSpaces.getState().create({ name: "a", root: "/old" });
    useSpaces.getState().setRootLocked(space.id, false, null);
    useSpaces.getState().setRootLocked(space.id, true, null);
    expect(useSpaces.getState().spaces[1]).toMatchObject({
      root: null,
      rootLocked: true,
      name: "old",
    });
  });

  it("keeps Default first and permanent while ordinary spaces can move and disappear", () => {
    const a = useSpaces.getState().create({ name: "a", root: null });
    const b = useSpaces.getState().create({ name: "b", root: null });
    useSpaces.getState().reorder([b.id, DEFAULT_SPACE_ID, a.id]);
    useSpaces.getState().rename(DEFAULT_SPACE_ID, "Changed");
    useSpaces.getState().remove(DEFAULT_SPACE_ID);
    expect(useSpaces.getState().spaces.map((space) => space.id)).toEqual([
      DEFAULT_SPACE_ID,
      b.id,
      a.id,
    ]);
    expect(useSpaces.getState().spaces[0]).toMatchObject({
      name: "Default",
      rootLocked: false,
    });
    expect(writes.remove).not.toHaveBeenCalled();
    useSpaces.getState().remove(b.id);
    expect(useSpaces.getState().spaces.map((space) => space.id)).toEqual([
      DEFAULT_SPACE_ID,
      a.id,
    ]);
  });

  it.each([
    ["/", "/"],
    ["C:\\", "c:/"],
    ["/work///", "/work"],
    ["//server/share/", "//server/share"],
  ])("normalizes %s without destroying filesystem roots", (input, expected) => {
    expect(normalizeSpaceRoot(input)).toBe(expected);
  });
});
