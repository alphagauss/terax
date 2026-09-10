import { describe, expect, it } from "vitest";
import {
  buildParameterOptions,
  type ModelParameter,
  parseParameterValue,
  resolveModelParameters,
  readModelParameters,
  validateModelParameters,
} from "./modelParameters";

const thinking: ModelParameter = {
  id: "thinking",
  label: "Thinking",
  target: "provider",
  path: "chat_template_kwargs.enable_thinking",
  valueType: "boolean",
  options: [
    { id: "on", label: "On", value: true },
    { id: "off", label: "Off", value: false },
    { id: "omit", label: "Service default", omit: true, value: null },
  ],
  defaultOption: "on",
  showInSummary: true,
};
describe("model parameters", () => {
  it("preserves an explicit JSON null and distinguishes it from an omitted parameter", () => {
    const parameter: ModelParameter = {
      ...thinking,
      valueType: "string",
      options: [
        { id: "omit", label: "Omit", omit: true, value: null },
        {
          id: "null",
          label: "Null",
          value: parseParameterValue("string", "null"),
        },
      ],
      defaultOption: "null",
    };
    expect(validateModelParameters([parameter])).toBeNull();
    expect(resolveModelParameters([parameter])[0].value).toBeNull();
    expect(resolveModelParameters([parameter], { thinking: "omit" })).toEqual(
      [],
    );
    expect(parseParameterValue("string", "false")).toBe("false");
    expect(parseParameterValue("boolean", "false")).toBe(false);
  });
  it("distinguishes inheritance from omission and freezes typed values", () => {
    const parameter = structuredClone(thinking);
    const frozen = resolveModelParameters([parameter], { thinking: "off" });
    parameter.options[1].value = true;
    expect(frozen[0].value).toBe(false);
    expect(resolveModelParameters([thinking], {})[0].value).toBe(true);
    expect(resolveModelParameters([thinking], { thinking: "omit" })).toEqual(
      [],
    );
    expect(
      resolveModelParameters([thinking], { thinking: "deleted" })[0].value,
    ).toBe(true);
  });
  it("merges sibling nested fields and maps only SDK-defined API names", () => {
    expect(
      buildParameterOptions(
        [
          {
            target: "provider",
            path: "chat_template_kwargs.enable_thinking",
            value: false,
          },
          {
            target: "provider",
            path: "chat_template_kwargs.preserve_thinking",
            value: true,
          },
          { target: "provider", path: "reasoning_effort", value: "medium" },
          { target: "standard", path: "top_p", value: 0.8 },
        ],
        "openai-compatible",
        "openai-compatible",
      ),
    ).toEqual({
      topP: 0.8,
      providerOptions: {
        openaiCompatible: {
          reasoningEffort: "medium",
          chat_template_kwargs: {
            enable_thinking: false,
            preserve_thinking: true,
          },
        },
      },
    });
  });
  it("rejects overlapping paths, reserved request fields and incorrect scalar types", () => {
    expect(
      validateModelParameters([
        {
          ...thinking,
          options: [
            ...thinking.options,
            { id: "other-omit", label: "Other", omit: true, value: null },
          ],
        },
      ]),
    ).toBe("duplicateOmit");
    expect(
      resolveModelParameters([{ ...thinking, defaultOption: "omit" }]),
    ).toEqual([]);
    expect(validateModelParameters([thinking])).toBeNull();
    expect(
      validateModelParameters([thinking, { ...thinking, id: "other" }]),
    ).toBe("duplicatePath");
    expect(
      validateModelParameters([{ ...thinking, path: "constructor.polluted" }]),
    ).toBe("invalidPath");
    expect(validateModelParameters([{ ...thinking, path: "messages" }])).toBe(
      "invalidPath",
    );
    expect(
      validateModelParameters([
        { ...thinking, options: [{ id: "on", label: "On", value: "false" }] },
      ]),
    ).toBe("invalidOptions");
    expect(
      validateModelParameters([
        { ...thinking, target: "standard", path: "temperature" },
      ]),
    ).toBe("invalidStandard");
  });
});

it("checks SDK aliases only for the selected adapter and preserves nested compatible fields", () => {
  const parameters: ModelParameter[] = [
    {
      ...thinking,
      path: "reasoning_effort",
      valueType: "string",
      options: [{ id: "on", label: "High", value: "high" }],
    },
    {
      ...thinking,
      id: "nested",
      path: "reasoning.effort",
      valueType: "string",
      options: [{ id: "on", label: "Low", value: "low" }],
    },
  ];
  expect(readModelParameters(parameters)).toEqual(parameters);
  expect(validateModelParameters(parameters, "openai-compatible")).toBeNull();
  expect(validateModelParameters(parameters, "openai")).toBe("duplicatePath");
  const assignments = resolveModelParameters(parameters);
  expect(
    buildParameterOptions(assignments, "openai-compatible", "deepseek"),
  ).toEqual({
    providerOptions: {
      deepseek: { reasoningEffort: "high", reasoning: { effort: "low" } },
    },
  });
  expect(() => buildParameterOptions(assignments, "openai", "openai")).toThrow(
    "paths overlap",
  );
});
