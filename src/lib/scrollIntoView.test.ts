// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { scrollListRowIntoView } from "./scrollIntoView";

it("reveals clipped rows within their own scroll container and leaves visible rows in place", () => {
  const outer = document.createElement("div");
  const container = document.createElement("div");
  const row = document.createElement("div");
  row.id = 'row/path:"quoted"';
  outer.append(container);
  container.append(row);
  outer.scrollTop = 75;
  container.scrollTop = 100;
  Object.defineProperty(container, "clientHeight", {
    value: 100,
    configurable: true,
  });
  Object.defineProperty(container, "clientTop", { value: 2 });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 50, 100, 104),
  );
  const bounds = vi.spyOn(row, "getBoundingClientRect");
  bounds.mockReturnValue(new DOMRect(0, 152, 100, 24));
  scrollListRowIntoView(container, row.id);
  expect(container.scrollTop).toBe(124);
  bounds.mockReturnValue(new DOMRect(0, 28, 100, 24));
  scrollListRowIntoView(container, row.id);
  expect(container.scrollTop).toBe(100);
  bounds.mockReturnValue(new DOMRect(0, 52, 100, 24));
  scrollListRowIntoView(container, row.id);
  expect(container.scrollTop).toBe(100);
  expect(outer.scrollTop).toBe(75);
  Object.defineProperty(container, "clientHeight", { value: 0 });
  bounds.mockReturnValue(new DOMRect(0, 200, 100, 24));
  scrollListRowIntoView(container, row.id);
  expect(container.scrollTop).toBe(100);
});
