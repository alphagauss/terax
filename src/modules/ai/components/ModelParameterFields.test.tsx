// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModelParameterFields } from "./ModelParameterFields";
import type { ModelParameter } from "@/modules/ai/lib/modelParameters";

it("shows the resolved default and only configured options, allowing an explicit same-value override", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const parameter: ModelParameter = {
    id: "thinking",
    label: "思考",
    target: "provider",
    path: "thinking.type",
    valueType: "string",
    options: [{ id: "off", label: "关", value: "disabled" }],
    defaultOption: "off",
    showInSummary: true,
  };
  const render = () =>
    root.render(
      <ModelParameterFields
        parameters={[parameter]}
        selections={{}}
        onChange={onChange}
      />,
    );
  try {
    await act(async () => render());
    const trigger = container.querySelector("button");
    expect(trigger?.textContent).toBe("关");
    await act(async () =>
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (o) => o.textContent,
      ),
    ).toEqual(["关"]);
    const option = document.querySelector('[role="option"]');
    await act(async () =>
      option?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(onChange).toHaveBeenCalledWith({ thinking: "off" });
    parameter.options.push({
      id: "omit",
      label: "服务默认",
      omit: true,
      value: null,
    });
    await act(async () => render());
    await act(async () =>
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (o) => o.textContent,
      ),
    ).toEqual(["关", "服务默认"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
