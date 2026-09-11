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
  setModelUsageParameters,
  setModelUsageModel,
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
      setModelUsageParameters("completion", ref, { thinking: "off" }),
    ]);
    expect(new Set(storage.set.mock.calls.map((call) => call[1])).size).toBe(3);
    const prefs = await loadPreferences();
    expect(prefs.modelParameters[modelRefKey(ref)]).toEqual([parameter]);
    expect(prefs.modelParameters[modelRefKey(other)][0].label).toBe("Other");
    expect(
      prefs.modelUsages.completion.parameterSelections[modelRefKey(ref)],
    ).toEqual({
      thinking: "off",
    });
    expect(prefs.modelParameters[modelRefKey(ref)][0].defaultOption).toBeNull();
  });
  it("isolates application models and per-model choices across independent writes", async () => {
    const other = { ...ref, providerId: "builtin:openai" };
    await Promise.all([
      setModelUsageModel("completion", ref),
      setModelUsageModel("subagent", other),
      setModelUsageParameters("completion", ref, { thinking: "off" }),
      setModelUsageParameters("subagent", ref, { thinking: "on" }),
      setModelUsageParameters("subagent", other, { thinking: "off" }),
    ]);
    expect(new Set(storage.set.mock.calls.map((call) => call[1])).size).toBe(5);
    await setModelUsageModel("subagent", null);
    await setModelUsageParameters("completion", ref, {});
    const { modelUsages } = await loadPreferences();
    expect(modelUsages.completion).toEqual({
      model: ref,
      parameterSelections: { [modelRefKey(ref)]: {} },
    });
    expect(modelUsages.subagent).toEqual({
      model: null,
      parameterSelections: {
        [modelRefKey(ref)]: { thinking: "on" },
        [modelRefKey(other)]: { thinking: "off" },
      },
    });
  });
  it("rejects invalid definitions before touching the shared store", async () => {
    await expect(
      setModelParameters(ref, [{ ...parameter, path: "messages" }]),
    ).rejects.toThrow("invalidPath");
    expect(storage.set).not.toHaveBeenCalled();
  });
  it("validates mapped paths against the model provider when saving", async () => {
    const parameters = [
      { ...parameter, path: "reasoning_effort" },
      { ...parameter, id: "nested", path: "reasoning.effort" },
    ];
    await setModelParameters(ref, parameters);
    expect((await loadPreferences()).modelParameters[modelRefKey(ref)]).toEqual(
      parameters,
    );
    storage.set.mockClear();
    await expect(
      setModelParameters({ ...ref, providerId: "builtin:openai" }, parameters),
    ).rejects.toThrow("duplicatePath");
    expect(storage.set).not.toHaveBeenCalled();
  });
});
