// @vitest-environment happy-dom

/**
 * 本文件测试应用关闭对话框的确认操作。
 *
 * 确认继续退出不能同时触发取消回调，否则会使刚启动的异步保存失效。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CloseDialogs } from "./CloseDialogs";

describe("CloseDialogs", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("确认应用退出时不会触发取消回调", () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    act(() => {
      root.render(
        <CloseDialogs
          tabs={[]}
          pendingCloseTab={null}
          onCancelClose={vi.fn()}
          onConfirmClose={vi.fn()}
          pendingTerminalCloseTab={null}
          onCancelTerminalClose={vi.fn()}
          onConfirmTerminalClose={vi.fn()}
          pendingDeleteTabs={null}
          onCancelDeleteClose={vi.fn()}
          onConfirmDeleteClose={vi.fn()}
          pendingCloseAllTabs={null}
          onCancelCloseAllTabs={vi.fn()}
          onConfirmCloseAllTabs={vi.fn()}
          onRestoreCloseAllTabsFocus={vi.fn()}
          pendingAppClose={{
            kind: "blocker",
            dirtyEditors: 1,
            busyTerminal: false,
          }}
          onCancelAppClose={cancel}
          onConfirmAppClose={confirm}
          pendingSpaceDelete={null}
          onCancelSpaceDelete={vi.fn()}
          onConfirmSpaceDelete={vi.fn()}
        />,
      );
    });
    const confirmButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "close.quitAnyway",
    );

    act(() => confirmButton?.click());

    expect(confirm).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
});
