/**
 * 本文件测试远程设置页的保存与 Workspace 启动语义。
 * 锁定隐式保存不显示成功提示，并区分进程启动失败和凭据持久化失败。
 */

// @vitest-environment happy-dom

import {
  act,
  createElement,
  Fragment,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

const mocks = vi.hoisted(() => ({
  deleteAuthSecret: vi.fn(),
  deleteProxySecret: vi.fn(),
  getProxySecret: vi.fn(),
  getSecret: vi.fn(),
  load: vi.fn(),
  saveProfile: vi.fn(),
  spawnWorkspaceProcess: vi.fn(),
  toastSuccess: vi.fn(),
}));

const profile = {
  id: "ssh-production",
  groupId: "default",
  name: "Production",
  host: "ssh.example.com",
  port: 22,
  username: "developer",
  authMethod: "agent" as const,
  identityFile: null,
  proxyUrl: null,
  proxyMode: "direct",
  reconnectEnabled: true,
  reconnectMaxAttempts: 2,
  rootPath: "~",
  tunnels: [],
};

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: string;
    variant?: string;
  }) => createElement("button", { type: "button", ...props }, children),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    onCheckedChange: _onCheckedChange,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => createElement("input", { type: "checkbox", ...props }),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) =>
    createElement("input", props),
}));

vi.mock("@/components/ui/label", () => ({
  Label: (props: LabelHTMLAttributes<HTMLLabelElement>) =>
    createElement("label", props),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
  CollapsibleContent: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
}));

vi.mock("@/components/ui/dialog", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? createElement(Fragment, null, children) : null,
    DialogContent: Wrapper,
    DialogDescription: Wrapper,
    DialogFooter: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: Wrapper,
  };
});

vi.mock("@/components/ui/alert-dialog", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  const Action = ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement("button", { type: "button", ...props }, children);
  return {
    AlertDialog: ({
      open,
      children,
    }: {
      open?: boolean;
      children?: ReactNode;
    }) => (open ? createElement(Fragment, null, children) : null),
    AlertDialogAction: Action,
    AlertDialogCancel: Action,
    AlertDialogContent: Wrapper,
    AlertDialogDescription: Wrapper,
    AlertDialogFooter: Wrapper,
    AlertDialogHeader: Wrapper,
    AlertDialogTitle: Wrapper,
  };
});

vi.mock("@/components/menu/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
}));

vi.mock("@/components/controls/select", () => ({
  Select: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  SelectValue: () => null,
}));

vi.mock("@/modules/remote", () => ({
  remoteNative: {
    deleteAuthSecret: mocks.deleteAuthSecret,
    deleteProxySecret: mocks.deleteProxySecret,
    getProxySecret: mocks.getProxySecret,
    getSecret: mocks.getSecret,
    importConfig: vi.fn(),
    setProxySecret: vi.fn(),
    setSecret: vi.fn(),
  },
  useRemoteStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      deleteGroup: vi.fn(),
      deleteProfile: vi.fn(),
      groups: [],
      load: mocks.load,
      profiles: [profile],
      saveGroup: vi.fn(),
      saveProfile: mocks.saveProfile,
      saveProfiles: vi.fn(),
    }),
}));

vi.mock("@/modules/remote/store", () => ({
  newGroupId: () => "ssh-group-new",
  newProfileId: () => "ssh-new",
}));

vi.mock("@/modules/workspace-process", () => ({
  spawnWorkspaceProcess: mocks.spawnWorkspaceProcess,
}));

vi.mock("@/settings/components/SectionHeader", () => ({
  SectionHeader: ({ title }: { title: string }) =>
    createElement("h1", null, title),
}));

vi.mock("@hugeicons/core-free-icons", () => ({
  Add01Icon: {},
  ArrowDown01Icon: {},
  Delete02Icon: {},
  Download01Icon: {},
  Edit02Icon: {},
  FloppyDiskIcon: {},
  FolderAddIcon: {},
  MoreHorizontalIcon: {},
}));

vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) =>
      options?.error ? `${key}: ${options.error}` : key,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess },
}));

import { RemoteSection } from "@/settings/sections/RemoteSection";

/** 渲染远程设置页并选中预置的 SSH 配置。 */
async function renderSelectedProfile(): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(RemoteSection)));
  const profileButton = Array.from(container.querySelectorAll("button")).find(
    (button) =>
      button.textContent?.includes("Productiondeveloper@ssh.example.com"),
  );
  expect(profileButton).toBeDefined();
  await act(async () => {
    profileButton?.click();
    await Promise.resolve();
  });
  return { container, root };
}

/** 点击指定文案的按钮，并等待异步事件处理完成。 */
async function clickButton(
  container: HTMLElement,
  label: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RemoteSection persistence and launch semantics", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.deleteAuthSecret.mockReset().mockResolvedValue(undefined);
    mocks.deleteProxySecret.mockReset().mockResolvedValue(undefined);
    mocks.getProxySecret.mockReset().mockResolvedValue(null);
    mocks.getSecret.mockReset().mockResolvedValue(null);
    mocks.load.mockReset().mockResolvedValue([profile]);
    mocks.saveProfile.mockReset().mockResolvedValue(undefined);
    mocks.spawnWorkspaceProcess.mockReset().mockResolvedValue(42);
    mocks.toastSuccess.mockReset();
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = "";
  });

  it("打开工作区时静默保存，显式保存时才提示已保存", async () => {
    const { container, root } = await renderSelectedProfile();

    await clickButton(container, "remote.actions.openWorkspace");

    expect(mocks.saveProfile).toHaveBeenCalledWith(profile);
    expect(mocks.spawnWorkspaceProcess).toHaveBeenCalledWith(
      { kind: "ssh", profileId: profile.id },
      "recent",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await clickButton(container, "common.save");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("remote.actions.saved");
    act(() => root.unmount());
  });

  it("配置保存后启动失败时展示部分成功信息", async () => {
    mocks.spawnWorkspaceProcess.mockRejectedValue(new Error("spawn denied"));
    const { container, root } = await renderSelectedProfile();

    await clickButton(container, "remote.actions.openWorkspace");

    expect(container.textContent).toContain(
      "remote.launch.openFailedAfterSave: Error: spawn denied",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("钥匙串更新失败时展示凭据错误且不启动工作区", async () => {
    mocks.deleteAuthSecret.mockRejectedValue(new Error("keychain unavailable"));
    const { container, root } = await renderSelectedProfile();

    await clickButton(container, "remote.actions.openWorkspace");

    expect(container.textContent).toContain(
      "remote.persistence.credentialsFailed: Error: keychain unavailable",
    );
    expect(mocks.spawnWorkspaceProcess).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
