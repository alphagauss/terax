// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), scrollToIndex: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (
    selector: (state: { showHidden: boolean }) => unknown,
  ) => selector({ showHidden: false }),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 28,
      })),
    scrollToIndex: mocks.scrollToIndex,
  }),
}));
import { DirectoryPathInput } from "./DirectoryPathInput";
import { useWorkspaceEnvStore } from "./env";
import { useRemoteRuntimeStore } from "@/modules/remote/runtimeStore";
import { directoryQuery } from "./directoryPath";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let input: HTMLInputElement;
const submit = vi.fn();
function Harness() {
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DirectoryPathInput
        value={value}
        onValueChange={setValue}
        aria-label="path"
      />
    </form>
  );
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
}
async function key(value: string) {
  let event!: KeyboardEvent;
  await act(async () => {
    event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
  });
  return event;
}
beforeEach(async () => {
  vi.useFakeTimers();
  mocks.invoke.mockReset();
  mocks.scrollToIndex.mockReset();
  submit.mockReset();
  mocks.invoke.mockResolvedValue(["home", "host", ".hidden"]);
  useWorkspaceEnvStore.setState({ env: { kind: "wsl", distro: "Ubuntu" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  input = container.querySelector("input") as HTMLInputElement;
  await act(async () => input.focus());
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
it("loads one level, filters locally and selects without descending or submitting", async () => {
  await type("/");
  await tick();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await type("/ho");
  await tick();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
  await key("ArrowDown");
  expect((await key("Enter")).defaultPrevented).toBe(true);
  expect(input.value).toBe("/home");
  expect(submit).not.toHaveBeenCalled();
  await tick();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect((await key("Enter")).defaultPrevented).toBe(false);
  await type("/home/");
  await tick();
  expect(mocks.invoke).toHaveBeenLastCalledWith(
    "list_subdirs",
    expect.objectContaining({ path: "/home/" }),
  );
});
it("loads pasted parents and ignores stale responses", async () => {
  let resolveOld!: (names: string[]) => void;
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise<string[]>((resolve) => {
        resolveOld = resolve;
      }),
  );
  await type("/old/pr");
  await tick();
  await type("/new/ho");
  await tick();
  await act(async () => resolveOld(["previous"]));
  expect(document.querySelector('[role="listbox"]')?.textContent).toBe(
    "homehost",
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
it("accepts mouse choices, handles hidden prefixes and Escape", async () => {
  await type("/.");
  await tick();
  expect(document.querySelector('[role="option"]')?.textContent).toBe(
    ".hidden",
  );
  await act(async () =>
    (document.querySelector('[role="option"]') as HTMLElement).click(),
  );
  expect(input.value).toBe("/.hidden");
  await type("/");
  await tick();
  expect((await key("Escape")).defaultPrevented).toBe(true);
  expect(input.getAttribute("aria-expanded")).toBe("false");
});
it("refreshes after SSH reconnect and rejects results from the old epoch", async () => {
  await act(async () => {
    useWorkspaceEnvStore.setState({ env: { kind: "ssh", profileId: "p" } });
    useRemoteRuntimeStore.setState({
      snapshot: {
        phase: "connected",
        version: 1,
        epoch: 1,
        profileId: "p",
        home: "/project",
      },
    });
  });
  await type("/");
  await tick();
  await act(async () =>
    useRemoteRuntimeStore.setState({
      snapshot: { phase: "reconnecting", version: 2, profileId: "p" },
    }),
  );
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  await act(async () =>
    useRemoteRuntimeStore.setState({
      snapshot: {
        phase: "connected",
        version: 3,
        epoch: 2,
        profileId: "p",
        home: "/project",
      },
    }),
  );
  await tick();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
it("passes home paths directly to the directory API and parses pasted paths", async () => {
  await type("~/pro");
  await tick();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
    "list_subdirs",
    expect.objectContaining({ path: "~/" }),
  );
  expect(directoryQuery("~")).toEqual({ parent: "~/", prefix: "" });
  expect(directoryQuery("/home/me/pro")).toEqual({
    parent: "/home/me/",
    prefix: "pro",
  });
  expect(directoryQuery("relative")).toBeNull();
  expect(directoryQuery("~other")).toBeNull();
});

it("debounces parent changes and leaves failures editable", async () => {
  mocks.invoke.mockRejectedValue(new Error("Permission denied"));
  await type("/a/");
  await type("/a/b/");
  await tick();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(
    "list_subdirs",
    expect.objectContaining({ path: "/a/b/" }),
  );
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "directoryListFailed",
  );
  expect(input.value).toBe("/a/b/");
  expect((await key("Enter")).defaultPrevented).toBe(false);
  mocks.invoke.mockResolvedValue(["home"]);
  await type("/");
  await tick();
  expect(document.querySelector('[role="option"]')?.textContent).toBe("home");
});

it("scrolls to the last candidate after reopening with ArrowUp", async () => {
  await type("/");
  await tick();
  await key("Escape");
  const mountedTargets: number[] = [];
  mocks.scrollToIndex.mockImplementation((index: number) => {
    if (document.querySelector('[role="listbox"]')) mountedTargets.push(index);
  });
  await key("ArrowUp");
  await tick();
  expect(mountedTargets).toContain(1);
});
