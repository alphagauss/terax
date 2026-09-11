import { describe, expect, it } from "vitest";
import { modelRefKey } from "@/modules/ai/config";
import type { ModelParameter } from "@/modules/ai/lib/modelParameters";
import { readModelUsages, resolveModelUsage } from "./modelUsage";

const model = { providerId: "builtin:openai", modelId: "test" };
const other = { ...model, providerId: "builtin:deepseek" };
const parameter: ModelParameter = {
  id: "effort",
  label: "Effort",
  target: "provider",
  path: "reasoning_effort",
  valueType: "string",
  options: [
    { id: "low", label: "Low", value: "low" },
    { id: "high", label: "High", value: "high" },
    { id: "omit", label: "Omit", value: "", omit: true },
    { id: "null", label: "Null", value: null },
  ],
  defaultOption: "high",
  showInSummary: true,
};

describe("model usage snapshots", () => {
  it("selects saved parameters using the actual followed or explicit model", () => {
    const usage = readModelUsages({}).subagent;
    const definitions = {
      [modelRefKey(model)]: [parameter],
      [modelRefKey(other)]: [parameter],
    };
    usage.parameterSelections[modelRefKey(model)] = { effort: "low" };
    usage.parameterSelections[modelRefKey(other)] = { effort: "high" };
    expect(resolveModelUsage(usage, definitions, model)).toMatchObject({
      model,
      parameters: [{ value: "low" }],
    });
    expect(resolveModelUsage(usage, definitions, other)).toMatchObject({
      model: other,
      parameters: [{ value: "high" }],
    });
    usage.model = model;
    usage.parameterSelections[modelRefKey(other)] = { effort: "omit" };
    expect(resolveModelUsage(usage, definitions, other)).toMatchObject({
      model,
      parameters: [{ value: "low" }],
    });
  });

  it("freezes the followed model and the subagent's own choices at task start", () => {
    const usages = readModelUsages({});
    usages.subagent.parameterSelections[modelRefKey(model)] = { effort: "low" };
    const definitions = { [modelRefKey(model)]: structuredClone([parameter]) };
    const parent = { ...model };
    const snapshot = resolveModelUsage(usages.subagent, definitions, parent);
    usages.subagent.parameterSelections[modelRefKey(model)].effort = "high";
    definitions[modelRefKey(model)][0].options[0].value = "changed";
    parent.modelId = "changed";
    expect(snapshot).toEqual({
      model,
      parameters: [
        { target: "provider", path: "reasoning_effort", value: "low" },
      ],
    });
    expect(resolveModelUsage(usages.completion, definitions, null)).toBeNull();
  });

  it("keeps explicit models and resolves defaults independently for each provider", () => {
    const usages = readModelUsages({});
    usages.subagent.model = other;
    usages.subagent.parameterSelections[modelRefKey(model)] = { effort: "low" };
    const definitions = {
      [modelRefKey(model)]: [parameter],
      [modelRefKey(other)]: [parameter],
    };
    expect(
      resolveModelUsage(usages.subagent, definitions, model),
    ).toMatchObject({ model: other, parameters: [{ value: "high" }] });
    usages.subagent.parameterSelections[modelRefKey(other)] = {
      effort: "removed",
    };
    expect(
      resolveModelUsage(usages.subagent, definitions, model)?.parameters[0]
        .value,
    ).toBe("high");
    usages.subagent.parameterSelections[modelRefKey(other)] = {
      effort: "omit",
    };
    expect(
      resolveModelUsage(usages.subagent, definitions, model)?.parameters,
    ).toEqual([]);
    usages.subagent.parameterSelections[modelRefKey(other)] = {
      effort: "null",
    };
    expect(
      resolveModelUsage(usages.subagent, definitions, model)?.parameters[0]
        .value,
    ).toBeNull();
  });
});
