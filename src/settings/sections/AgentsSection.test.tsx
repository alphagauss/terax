// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentEditorDialog } from "./AgentsSection";
import { MAIN_AGENT, CHANNEL_AGENT } from "@/modules/ai/lib/agents";
import { usePreferencesStore } from "@/modules/settings/preferences";

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function renderEditor(
  agent = MAIN_AGENT,
  onSave = vi.fn().mockResolvedValue(undefined),
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <AgentEditorDialog
        agent={agent}
        existing={[MAIN_AGENT, CHANNEL_AGENT]}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    ),
  );
  return onSave;
}

it("shows ordered prompt sections without loading a workspace and uses individual tool IDs", async () => {
  usePreferencesStore.setState({ customInstructions: "Global rule" });
  await renderEditor(CHANNEL_AGENT);
  const text = document.body.textContent ?? "";
  const positions = ["core", "environment", "workspace", "agent", "custom"].map(
    (kind) => text.indexOf(`agents.prompt.${kind}`),
  );
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(text).toContain("Global rule");
  expect(text).toContain("agents.prompt.environmentRuntime");
  expect(document.querySelector("#agent-workspace-files")).toHaveProperty(
    "value",
    "AGENTS.md",
  );
  expect(
    document.querySelector("#agent-tool-get_terminal_output"),
  ).toHaveProperty("disabled", true);
  expect(document.querySelector("#agent-tool-workspaceRead")).toBeNull();
  expect(
    document.querySelectorAll('[id^="agent-tool-"][role="checkbox"]'),
  ).toHaveLength(13);
});

it("saves an explicitly empty prompt and only the necessary dependency, preserving edits on failure", async () => {
  const save = vi.fn().mockRejectedValue(new Error("disk full"));
  await renderEditor({ ...MAIN_AGENT, instructions: "", tools: [] }, save);
  await act(async () =>
    (
      document.querySelector("#agent-tool-write_file") as HTMLButtonElement
    ).click(),
  );
  expect(
    document
      .querySelector("#agent-tool-read_file")
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    document
      .querySelector("#agent-tool-find_files")
      ?.getAttribute("aria-checked"),
  ).toBe("false");
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === "common.save",
  );
  if (!button) throw new Error("Save button is missing");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      instructions: "",
      tools: ["read_file", "write_file"],
      workspaceFiles: ["AGENTS.md"],
    }),
  );
  expect(document.body.textContent).toContain("agents.agentDialog.saveFailed");
  expect(document.querySelector("#agent-instructions")).toHaveProperty(
    "value",
    "",
  );
  expect(button.disabled).toBe(false);
});
