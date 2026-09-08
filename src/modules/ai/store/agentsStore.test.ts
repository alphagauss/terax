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
  expect(shared.read).toHaveBeenCalledTimes(2);
  expect(shared.listen).toHaveBeenCalledTimes(1);
});
