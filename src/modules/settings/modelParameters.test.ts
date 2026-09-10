import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelRefKey } from "@/modules/ai/config";
import type { ModelParameter } from "@/modules/ai/lib/modelParameters";
const storage = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  set: vi.fn(),
}));
vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: async () => storage.values,
  setSharedStoreKey: storage.set,
  mutateSharedStore: vi.fn(),
  onSharedStoreChange: vi.fn(),
}));
import {
  loadPreferences,
  setCompletionParameterSelections,
  setModelParameters,
} from "./store";

const ref = { providerId: "builtin:deepseek", modelId: "model" };
const parameter: ModelParameter = {
  id: "thinking",
  label: "Thinking",
  target: "provider",
  path: "thinking.type",
  valueType: "string",
  options: [{ id: "off", label: "Off", value: "disabled" }],
  defaultOption: null,
  showInSummary: true,
};
beforeEach(() => {
  storage.values = {};
  storage.set.mockReset();
  storage.set.mockImplementation(async (_store, key, value) => {
    storage.values[key] = structuredClone(value);
  });
});
describe("model parameter persistence", () => {
  it("keeps model definitions and completion choices in separate precise records", async () => {
    const other = { ...ref, modelId: "other" };
    await Promise.all([
      setModelParameters(ref, [parameter]),
      setModelParameters(other, [{ ...parameter, label: "Other" }]),
      setCompletionParameterSelections(ref, { thinking: "off" }),
    ]);
    expect(new Set(storage.set.mock.calls.map((call) => call[1])).size).toBe(3);
    const prefs = await loadPreferences();
    expect(prefs.modelParameters[modelRefKey(ref)]).toEqual([parameter]);
    expect(prefs.modelParameters[modelRefKey(other)][0].label).toBe("Other");
    expect(prefs.completionParameterSelections[modelRefKey(ref)]).toEqual({
      thinking: "off",
    });
    expect(prefs.modelParameters[modelRefKey(ref)][0].defaultOption).toBeNull();
  });
  it("rejects invalid definitions before touching the shared store", async () => {
    await expect(
      setModelParameters(ref, [{ ...parameter, path: "messages" }]),
    ).rejects.toThrow("invalidPath");
    expect(storage.set).not.toHaveBeenCalled();
  });
});
