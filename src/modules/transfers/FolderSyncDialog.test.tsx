// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderSyncDialog } from "@/modules/transfers/FolderSyncDialog";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  enqueue: vi.fn(),
  pick: vi.fn(),
  panel: vi.fn(),
  close: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/modules/transfers/native", () => ({
  transferNative: { syncPreview: mocks.preview, enqueue: mocks.enqueue },
}));
vi.mock("@/modules/transfers/dialogs", () => ({
  pickDownloadDirectory: mocks.pick,
}));
vi.mock("@/modules/transfers/store", () => ({
  requestTransferPanel: mocks.panel,
}));
vi.mock("@/components/controls/dialog", () => {
  const Part = ({ children }: { children: ReactNode }) =>
    createElement("div", null, children);
  return {
    Dialog: Part,
    DialogContent: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogTitle: Part,
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.pick.mockResolvedValue("C:/local/project");
  mocks.preview.mockResolvedValue({
    added: 1,
    updated: 2,
    skipped: 3,
    conflicts: 0,
    bytes: 10,
    items: [],
    truncated: false,
  });
  mocks.enqueue.mockResolvedValue({ id: "sync-task" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <FolderSyncDialog remotePath="/srv/project" onClose={mocks.close} />,
    ),
  );
});

it("does not let a closed dialog's enqueue completion close a later dialog", async () => {
  await click("sync.chooseDirectory");
  await click("sync.preview");
  let complete: (task: { id: string }) => void = () => {};
  mocks.enqueue.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await click("sync.start");
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      <FolderSyncDialog remotePath="/srv/other" onClose={mocks.close} />,
    ),
  );
  await act(async () => complete({ id: "late-task" }));
  expect(mocks.panel).toHaveBeenCalledWith("late-task");
  expect(mocks.close).not.toHaveBeenCalled();
  expect(container.textContent).toContain("/srv/other");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

it("requires a current preview and maps folder contents in the chosen direction", async () => {
  expect(button("sync.start").disabled).toBe(true);
  await click("sync.chooseDirectory");
  await click("sync.preview");
  expect(mocks.preview).toHaveBeenCalledWith({
    direction: "upload",
    strategy: "archive",
    sources: ["C:/local/project"],
    destination: "/srv/project",
    sync: {
      excludes: [".git"],
      excludeDirectories: [],
      respectGitignore: true,
    },
  });
  expect(button("sync.start").disabled).toBe(false);
  await click("sync.download");
  expect(button("sync.start").disabled).toBe(true);
  await click("sync.preview");
  await click("sync.start");
  expect(mocks.enqueue).toHaveBeenCalledWith({
    direction: "download",
    strategy: "archive",
    sources: ["/srv/project"],
    destination: "C:/local/project",
    sync: {
      excludes: [".git"],
      excludeDirectories: [],
      respectGitignore: true,
    },
  });
  expect(mocks.panel).toHaveBeenCalledWith("sync-task");
});

it("does not start when the preview contains conflicts or no changes", async () => {
  await click("sync.chooseDirectory");
  mocks.preview.mockResolvedValueOnce({
    added: 1,
    updated: 0,
    skipped: 0,
    conflicts: 1,
    bytes: 3,
    items: [{ path: "conflict", action: "conflict" }],
    truncated: false,
  });
  await click("sync.preview");
  expect(button("sync.start").disabled).toBe(true);
  expect(container.textContent).toContain("sync.conflictsHint");
  mocks.preview.mockResolvedValueOnce({
    added: 0,
    updated: 0,
    skipped: 2,
    conflicts: 0,
    bytes: 0,
    items: [],
    truncated: false,
  });
  await click("sync.preview");
  expect(button("sync.start").disabled).toBe(true);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("invalidates previews when presets change and keeps directory exclusions separate", async () => {
  await click("sync.chooseDirectory");
  await click("sync.preview");
  const target = container.querySelector<HTMLButtonElement>(
    'button[id$="-target"]',
  );
  expect(target?.getAttribute("aria-checked")).toBe("false");
  await act(async () => target?.click());
  expect(button("sync.start").disabled).toBe(true);
  await click("sync.preview");
  expect(mocks.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sync: {
        excludes: [".git"],
        excludeDirectories: ["target"],
        respectGitignore: true,
      },
    }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[id$="-ignore"]')
      ?.click(),
  );
  expect(button("sync.start").disabled).toBe(true);
  await click("sync.preview");
  expect(mocks.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sync: {
        excludes: [".git"],
        excludeDirectories: ["target"],
        respectGitignore: false,
      },
    }),
  );
});

it("validates individual custom tags and prevents previews with an unadded draft", async () => {
  await click("sync.chooseDirectory");
  const input = container.querySelector<HTMLInputElement>(
    "input:not([type=checkbox])",
  );
  if (!input) throw new Error("Missing exclusion input");
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("a/b");
  await click("sync.addExclude");
  expect(container.textContent).toContain("sync.invalidExclude");
  expect(button("sync.preview").disabled).toBe(true);
  await type(".cache");
  await click("sync.addExclude");
  await click("sync.preview");
  expect(mocks.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sync: {
        excludes: [".git", ".cache"],
        excludeDirectories: [],
        respectGitignore: true,
      },
    }),
  );
  await type(".cache");
  await click("sync.addExclude");
  expect(container.textContent).toContain("sync.duplicateExclude");
  await type("");
  const remove = container.querySelector<HTMLButtonElement>(
    'button[aria-label="sync.removeExclude"]',
  );
  await act(async () => remove?.click());
  expect(button("sync.start").disabled).toBe(true);
  await click("sync.preview");
  expect(mocks.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sync: {
        excludes: [".git"],
        excludeDirectories: [],
        respectGitignore: true,
      },
    }),
  );
});
