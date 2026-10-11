import { beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  mutate: vi.fn(),
}));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: async () => structuredClone(storage.values),
  setSharedStoreKey: vi.fn(),
  mutateSharedStore: storage.mutate,
  onSharedStoreChange: vi.fn(),
}));
import { loadPreferences, setProviderBaseURL } from "@/modules/settings/store";

beforeEach(() => {
  storage.values = {};
  storage.mutate.mockReset().mockImplementation(async (_store, changes) => {
    for (const change of changes) {
      if (change.kind === "delete") delete storage.values[change.key];
      else storage.values[change.key] = change.value;
    }
  });
});

it("persists independent cloud and local overrides without writing a stale provider map", async () => {
  await Promise.all([
    setProviderBaseURL("openai", " https://gateway.example/v1 "),
    setProviderBaseURL("lmstudio", "http://localhost:9000/v1"),
  ]);
  expect((await loadPreferences()).providerBaseURLs).toEqual({
    openai: "https://gateway.example/v1",
    lmstudio: "http://localhost:9000/v1",
  });
  expect(storage.mutate).toHaveBeenCalledWith("settings", [
    {
      kind: "set",
      key: "providerBaseURL:openai",
      value: "https://gateway.example/v1",
    },
  ]);
  await setProviderBaseURL("openai", "https://api.openai.com/v1");
  expect(storage.values).not.toHaveProperty("providerBaseURL:openai");
  expect((await loadPreferences()).providerBaseURLs).toEqual({
    lmstudio: "http://localhost:9000/v1",
  });
  await setProviderBaseURL("lmstudio", "  ");
  expect((await loadPreferences()).providerBaseURLs).toEqual({});
  expect(storage.values).toEqual({});
});
