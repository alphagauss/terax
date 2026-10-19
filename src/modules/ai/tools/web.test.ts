import { asSchema } from "ai";
import { expect, it, vi } from "vitest";
import { buildWebTools } from "./web";
import { resolveSubagentTools } from "@/modules/ai/lib/agentTools";

it("keeps tool schemas stable across service selection and handles disabled services explicitly", async () => {
  const disabled = buildWebTools({} as never);
  const enabled = buildWebTools({ webServices: { search: vi.fn() } } as never);
  for (const id of ["web_search", "web_fetch"] as const)
    expect(
      await asSchema<unknown>(disabled[id].inputSchema).jsonSchema,
    ).toEqual(await asSchema<unknown>(enabled[id].inputSchema).jsonSchema);
  expect(
    await disabled.web_search.execute?.(
      { query: "q" },
      { context: undefined as never, toolCallId: "call", messages: [] },
    ),
  ).toEqual({ error: "Web search is not enabled." });
  expect(
    resolveSubagentTools(["web_fetch", "web_search", "shell_exec"], "ask"),
  ).toEqual(["web_search", "web_fetch"]);
});

it("forwards cancellation and marks results as untrusted without adding display data", async () => {
  const search = vi.fn().mockResolvedValue([
    {
      title: "A",
      url: "https://example.com",
      content: "Text",
      truncated: false,
    },
  ]);
  const tools = buildWebTools({ webServices: { search } } as never);
  const signal = new AbortController().signal;
  const output = await tools.web_search.execute?.(
    { query: "q" },
    {
      context: undefined as never,
      toolCallId: "call",
      messages: [],
      abortSignal: signal,
    },
  );
  expect(search).toHaveBeenCalledWith({ query: "q", count: 5 }, signal);
  expect(output).toEqual({
    notice: expect.stringContaining("untrusted data"),
    results: [
      {
        title: "A",
        url: "https://example.com",
        content: "Text",
        truncated: false,
      },
    ],
  });
});
