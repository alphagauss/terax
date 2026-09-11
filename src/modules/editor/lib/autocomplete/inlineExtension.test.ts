// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { createProviderConnection } from "@/modules/ai/providerRegistry";
import {
  type AutocompletePrefs,
  inlineCompletion,
  triggerInlineCompletion,
} from "./inlineExtension";
import { requestCompletion } from "./provider";

vi.mock("./provider", () => ({ requestCompletion: vi.fn() }));
let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("completion parameter changes", () => {
  it("keeps in-flight configuration and results while new requests use independent caches", async () => {
    vi.useFakeTimers();
    let finish!: (text: string) => void;
    vi.mocked(requestCompletion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const prefs = {
      enabled: true,
      trigger: "manual",
      modelId: "model",
      connection: createProviderConnection({
        provider: "deepseek",
        instanceId: "builtin:deepseek",
        credentialValue: "test",
      }),
      parameters: [
        { target: "provider", path: "reasoning_effort", value: "low" },
      ],
    } satisfies AutocompletePrefs;
    view = new EditorView({
      doc: "const answer = ",
      selection: { anchor: 15 },
      extensions: [
        inlineCompletion({
          getPrefs: () => prefs,
          getPath: () => "test.ts",
          getLanguage: () => "typescript",
        }),
      ],
    });
    triggerInlineCompletion(view);
    await vi.advanceTimersByTimeAsync(1);
    prefs.parameters[0].value = "high";
    finish("42");
    await vi.advanceTimersByTimeAsync(1);
    expect(view.dom.querySelector(".cm-ai-ghost")?.textContent).toBe("42");
    expect(
      vi.mocked(requestCompletion).mock.calls[0][1].parameters?.[0].value,
    ).toBe("low");
    vi.mocked(requestCompletion).mockResolvedValue("43");
    triggerInlineCompletion(view);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.dom.querySelector(".cm-ai-ghost")?.textContent).toBe("43");
    prefs.parameters[0].value = "low";
    triggerInlineCompletion(view);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCompletion).toHaveBeenCalledTimes(2);
    expect(view.dom.querySelector(".cm-ai-ghost")?.textContent).toBe("42");
    expect(
      vi.mocked(requestCompletion).mock.calls[1][1].parameters?.[0].value,
    ).toBe("high");

    // 模型变化不能作废请求，但文档变化即使保持光标位置也必须丢弃旧结果。
    prefs.modelId = "another-model";
    vi.mocked(requestCompletion).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    triggerInlineCompletion(view);
    await vi.advanceTimersByTimeAsync(1);
    view.dispatch({ changes: { from: 0, to: 1, insert: "C" } });
    finish("stale");
    await vi.advanceTimersByTimeAsync(1);
    expect(view.dom.querySelector(".cm-ai-ghost")).toBeNull();
  });
});
