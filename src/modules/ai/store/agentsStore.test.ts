import { expect, it, vi } from "vitest";
const shared = vi.hoisted(() => ({ read: vi.fn(), listen: vi.fn() }));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: shared.read,
  onSharedStoreChange: shared.listen,
}));

it("shares initialization and can retry after an initial read failure", async () => {
  const { useAgentsStore } = await import("./agentsStore");
  shared.read
    .mockRejectedValueOnce(new Error("read failed"))
    .mockResolvedValue({});
  shared.listen.mockResolvedValue(() => {});
  const first = useAgentsStore.getState().hydrate();
  expect(useAgentsStore.getState().hydrate()).toBe(first);
  await expect(first).rejects.toThrow("read failed");
  expect(useAgentsStore.getState().hydrated).toBe(false);
  await useAgentsStore.getState().hydrate();
  expect(useAgentsStore.getState().hydrated).toBe(true);
  expect(shared.read).toHaveBeenCalledTimes(3);
  expect(shared.listen).toHaveBeenCalledTimes(2);
  const { readAgentConfiguration } = await import("../lib/agentConfiguration");
  expect((await readAgentConfiguration("builtin:main")).tools).not.toContain(
    "web_search",
  );
  const rawTools = useAgentsStore.getState().agents[0].tools;
  shared.read.mockImplementation(async (store) =>
    store === "settings" ? { "web.searchProvider": "deepseek" } : {},
  );
  const refresh = shared.listen.mock.calls.find(
    ([store]) => store === "settings",
  )?.[1];
  await refresh();
  expect((await readAgentConfiguration("builtin:main")).tools).toContain(
    "web_search",
  );
  expect(useAgentsStore.getState().agents[0].tools).toBe(rawTools);
});
