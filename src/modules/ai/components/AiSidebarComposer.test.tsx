/**
 * 本文件验证运行中输入切换为引导操作，且有草稿时仍能中止。
 * 使用真实工具栏组件验证点击行为和待接入反馈，不启动模型或原生会话。
 */
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { preloadEn } from "@/i18n";
import { AiSidebarComposer } from "@/modules/ai/components/AiSidebarComposer";

const composer = vi.hoisted(() => ({
  isBusy: true,
  canSend: false,
  canSteer: true,
  readOnly: false,
  pendingSteering: 0,
  workingDirectory: null,
  files: [],
  pickedSnippets: [],
  pickedCommands: [],
  voice: { supported: false },
  stop: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@/modules/ai/lib/composer", () => ({
  ACCEPTED_FILES: "",
  useComposer: () => composer,
}));
vi.mock("@/modules/ai/components/AiComposerInput", () => ({
  AiComposerInput: () => null,
}));

it("运行中从中止切为引导，提交后恢复中止并显示待接入状态", async () => {
  await preloadEn();
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => act(() => root.render(<AiSidebarComposer />));
  try {
    render();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Stop"]')
        ?.click(),
    );
    expect(composer.stop).toHaveBeenCalledTimes(1);
    composer.canSend = true;
    render();
    const guide = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Guide the current task"]',
    );
    expect(guide).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop"]')).not.toBeNull();
    act(() => guide?.click());
    expect(composer.submit).toHaveBeenCalledTimes(1);
    composer.canSend = false;
    composer.pendingSteering = 1;
    render();
    expect(container.querySelector('button[aria-label="Stop"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Awaiting guidance: 1",
    );
  } finally {
    act(() => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
