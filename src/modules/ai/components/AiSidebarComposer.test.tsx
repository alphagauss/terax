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
  canPickFiles: true,
  pickFiles: vi.fn(),
  pendingSteering: 0,
  workingDirectory: null as string | null,
  workingDirectoryAction: null as "reset" | "restore" | null,
  changeWorkingDirectory: vi.fn(),
  canRevealWorkingDirectory: true,
  revealWorkingDirectory: vi.fn(),
  files: [],
  pickedSnippets: [],
  voice: { supported: false },
  stop: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@/modules/ai/lib/composer", () => ({
  useComposer: () => composer,
}));
vi.mock("@/modules/ai/hooks/useComposerDrop", () => ({
  useComposerDrop: () => ({ ref: { current: null }, active: false, label: "" }),
}));
vi.mock("@/modules/ai/components/AiComposerInput", () => ({
  AiComposerInput: () => <div data-testid="composer-input" />,
}));

it("运行中提交引导后在输入框上方显示待接入状态", async () => {
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
    const status = container.querySelector<HTMLElement>('[role="status"]');
    const input = container.querySelector<HTMLElement>(
      '[data-testid="composer-input"]',
    );
    expect(status?.textContent).toContain("Awaiting guidance: 1");
    expect(status?.parentElement).toBe(input?.parentElement);
    expect(
      [...(status?.parentElement?.children ?? [])].indexOf(status as Element),
    ).toBeLessThan(
      [...(input?.parentElement?.children ?? [])].indexOf(input as Element),
    );
  } finally {
    act(() => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("草稿图标单独重置目录，点击路径仍导航，历史会话没有重置入口", async () => {
  await preloadEn();
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    composer.workingDirectory = "/project";
    composer.workingDirectoryAction = "reset";
    act(() => root.render(<AiSidebarComposer />));
    const reset = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Restore default working directory"]',
    );
    expect(reset).not.toBeNull();
    expect(reset?.textContent).not.toContain("/project");
    act(() => reset?.click());
    expect(composer.changeWorkingDirectory).toHaveBeenCalledTimes(1);
    expect(composer.revealWorkingDirectory).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Working directory: /project"]',
        )
        ?.click(),
    );
    expect(composer.revealWorkingDirectory).toHaveBeenCalledTimes(1);
    composer.workingDirectory = "/default/workspace";
    composer.workingDirectoryAction = "restore";
    act(() => root.render(<AiSidebarComposer />));
    const restore = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume following the current project directory"]',
    );
    expect(restore).not.toBeNull();
    expect(restore?.textContent).not.toContain("/default/workspace");
    act(() => restore?.click());
    expect(composer.changeWorkingDirectory).toHaveBeenCalledTimes(2);
    expect(composer.revealWorkingDirectory).toHaveBeenCalledTimes(1);
    composer.workingDirectoryAction = null;
    act(() => root.render(<AiSidebarComposer />));
    expect(container.contains(reset)).toBe(false);
    expect(container.contains(restore)).toBe(false);
    const path = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Working directory: /default/workspace"]',
    );
    expect(path?.querySelector("svg")).toBeNull();
    const icon = path?.previousElementSibling;
    expect(icon?.tagName).toBe("SPAN");
    expect(icon?.querySelector("svg")).not.toBeNull();
    act(() => path?.click());
    expect(composer.revealWorkingDirectory).toHaveBeenCalledTimes(2);
  } finally {
    composer.workingDirectory = null;
    composer.workingDirectoryAction = null;
    act(() => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("远端禁用原生文件选择入口，本机点击调用选择器", async () => {
  await preloadEn();
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    composer.canPickFiles = false;
    act(() => root.render(<AiSidebarComposer />));
    const remote = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Upload files to this environment first, then attach them from the file tree."]',
    );
    expect(remote?.disabled).toBe(true);
    act(() => remote?.click());
    expect(composer.pickFiles).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    composer.canPickFiles = true;
    act(() => root.render(<AiSidebarComposer />));
    const local = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Attach file or image"]',
    );
    expect(local?.disabled).toBe(false);
    act(() => local?.click());
    expect(composer.pickFiles).toHaveBeenCalledTimes(1);
  } finally {
    composer.canPickFiles = true;
    act(() => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
