// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ErrorNotice,
  type ErrorNoticeProps,
} from "@/components/errors/ErrorNotice";
import { ErrorHost } from "@/components/errors/ErrorHost";
import {
  clearErrors,
  dismissError,
  errorStore,
  reportError,
  setErrorHistoryOpen,
} from "@/lib/errors";

vi.mock("@/lib/clipboard", () => ({ writeClipboardText: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let identity: string;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearErrors();
  identity = crypto.randomUUID();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(props: Partial<ErrorNoticeProps> = {}, copies = 1) {
  await act(async () =>
    root.render(
      <>
        {["primary", "secondary"].slice(0, copies).map((location) => (
          <ErrorNotice
            key={location}
            identity={identity}
            title="failed"
            options={{ description: "diagnostic" }}
            mode="both"
            hasDetails
            dismissible
            {...props}
          />
        ))}
        <ErrorHost />
      </>,
    ),
  );
}

async function clickInline(label: string) {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("浮层关闭和清空历史都保留原位提示，详情仅主动恢复且不重新弹出", async () => {
  await render();
  const id = errorStore.getState().reports[0].id;
  await act(async () => dismissError(id));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => clearErrors());
  await render({ visible: false });
  await render();
  expect(errorStore.getState().reports).toHaveLength(0);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await clickInline("errors.details");
  expect(errorStore.getState().reports).toHaveLength(1);
  expect(errorStore.getState().reports[0]).toMatchObject({
    visible: false,
    count: 1,
  });
  expect(
    document.querySelector("[data-error-host] pre")?.textContent,
  ).toContain("diagnostic");
  await act(async () => setErrorHistoryOpen(false));
  expect(document.querySelector("[data-error-host]")).toBeNull();
});

it.each(["inline", "both"] as const)(
  "%s 模式按运行身份联动关闭，重挂载不复活，新失败仍可提醒",
  async (mode) => {
    await render({ mode }, 2);
    const old = errorStore.getState().reports[0];
    expect(errorStore.getState().reports).toHaveLength(mode === "both" ? 1 : 0);
    await clickInline("errors.dismissNotice");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    if (mode === "both")
      expect(errorStore.getState().reports[0]).toMatchObject({
        id: old.id,
        visible: false,
      });
    await render({}, 0);
    await render({ mode }, 2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    if (mode === "both") expect(errorStore.getState().reports[0].count).toBe(1);
    await render({ mode, identity: crypto.randomUUID() });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(errorStore.getState().reports).toHaveLength(mode === "both" ? 2 : 0);
    if (mode === "both")
      expect(errorStore.getState().reports[0]).toMatchObject({
        visible: true,
        count: 1,
      });
  },
);

it("不同运行的相同错误互不合并或联动关闭", async () => {
  const otherIdentity = crypto.randomUUID();
  await act(async () =>
    root.render(
      <>
        <ErrorNotice
          identity={identity}
          title="failed"
          mode="both"
          dismissible
        />
        <ErrorNotice
          identity={otherIdentity}
          title="failed"
          mode="both"
          dismissible
        />
      </>,
    ),
  );
  expect(errorStore.getState().reports).toHaveLength(2);
  await clickInline("errors.dismissNotice");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(
    errorStore
      .getState()
      .reports.find((item) => item.identity === otherIdentity)?.visible,
  ).toBe(true);
});

it("详情定位旧记录并展开，重复查看不计数，历史淘汰后仅恢复目标", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  await render();
  const id = errorStore.getState().reports[0].id;
  await act(async () => reportError("unrelated", { description: "other" }));
  await clickInline("errors.details");
  expect(errorStore.getState().historyTarget?.id).toBe(id);
  expect(document.querySelectorAll("[data-error-host] pre")).toHaveLength(1);
  expect(
    document.querySelector("[data-error-host] pre")?.textContent,
  ).toContain("diagnostic");
  expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  await act(async () => {
    document
      .querySelector<HTMLButtonElement>(
        '[data-error-host] button[aria-label="failed"]',
      )
      ?.click();
  });
  expect(document.querySelector("[data-error-host] pre")).toBeNull();
  await clickInline("errors.details");
  expect(document.querySelector("[data-error-host] pre")).not.toBeNull();
  expect(
    errorStore.getState().reports.find((item) => item.id === id)?.count,
  ).toBe(1);
  await act(async () => {
    dismissError(id);
    for (let index = 0; index < 55; index++) reportError(`other ${index}`);
  });
  expect(errorStore.getState().reports.some((item) => item.id === id)).toBe(
    false,
  );
  await clickInline("errors.details");
  expect(errorStore.getState().reports[0]).toMatchObject({
    identity,
    visible: false,
    count: 1,
  });
});

it("业务恢复收起浮层并保留历史，隐藏和卸载不视为恢复", async () => {
  await render();
  await render({ visible: false });
  expect(errorStore.getState().reports[0].visible).toBe(true);
  await render({}, 0);
  expect(errorStore.getState().reports[0].visible).toBe(true);
  await render({ active: false });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(errorStore.getState().reports[0].visible).toBe(false);
  expect(errorStore.getState().reports).toHaveLength(1);
  const nextIdentity = crypto.randomUUID();
  await render({ identity: nextIdentity, active: false });
  await render({ identity: nextIdentity });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(errorStore.getState().reports[0]).toMatchObject({
    identity: nextIdentity,
    visible: true,
  });
});

it("原位和历史操作位于表单内时不触发提交", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  await act(async () =>
    root.render(
      <form onSubmit={submit}>
        <div role="dialog" aria-label="settings">
          <ErrorNotice
            identity={identity}
            title="failed"
            hasDetails
            dismissible
          />
          <ErrorHost />
        </div>
      </form>,
    ),
  );
  await clickInline("errors.details");
  expect(
    document.querySelector('[role="dialog"] [data-error-host]'),
  ).not.toBeNull();
  for (const label of ["errors.copy", "errors.hideDetails", "errors.clear"]) {
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>("[data-error-host] button"),
    ).find((item) => item.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  }
  await clickInline("errors.dismissNotice");
  expect(submit).not.toHaveBeenCalled();
});

it("运行时已报告的错误由原位复用，不重复计数或覆盖诊断", async () => {
  const id = reportError("runtime failure", {
    identity,
    description: "original diagnostic",
  });
  await render();
  await clickInline("errors.details");
  expect(errorStore.getState().reports).toHaveLength(1);
  expect(errorStore.getState().reports[0]).toMatchObject({
    id,
    count: 1,
    details: "original diagnostic",
  });
  expect(errorStore.getState().historyTarget?.id).toBe(id);
});
