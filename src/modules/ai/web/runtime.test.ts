import { expect, it, vi } from "vitest";
import { prepareWebServices } from "./runtime";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/nativeHost", () => ({ invokeNative: mocks.invoke }));
vi.mock("@/lib/http", () => ({ createHttpFetch: () => mocks.request }));

it("freezes credentials without rereading tool availability", async () => {
  mocks.request.mockImplementation(async () => Response.json({ results: [] }));
  const first = await prepareWebServices(
    "first-key",
    "https://custom.example/v1",
  );
  const next = await prepareWebServices("next-key");
  expect(first.fetch).toBeTypeOf("function");
  expect(next.search).toBeTypeOf("function");
  expect(next.fetch).toBeTypeOf("function");
  await first.search?.({ query: "q", count: 5 });
  expect(mocks.request).toHaveBeenCalledWith(
    "https://custom.example/v1/tools/search",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer first-key" }),
    }),
  );
  expect(mocks.invoke).not.toHaveBeenCalled();
});
