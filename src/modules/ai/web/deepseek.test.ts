import { describe, expect, it, vi } from "vitest";
import { createDeepSeekWebClient } from "./deepseek";
import { webFetchInput, webSearchInput } from "@/modules/ai/tools/web";

describe("web service boundaries", () => {
  it("does not expose malformed response bodies", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret credential, not JSON"));
    await expect(
      createDeepSeekWebClient(
        "secret",
        "https://api.deepseek.com",
        request,
      ).fetch("https://example.com"),
    ).rejects.toThrow("DeepSeek returned an unreadable fetch response.");
  });
  it("validates Unicode queries, bounded counts and credential-free HTTP URLs", () => {
    expect(webSearchInput.safeParse({ query: "𠮷".repeat(128) }).success).toBe(
      true,
    );
    for (const input of [
      { query: " " },
      { query: "x".repeat(129) },
      { query: "ok", count: 11 },
      { query: "ok", count: 1.5 },
    ])
      expect(webSearchInput.safeParse(input).success).toBe(false);
    for (const url of [
      "file:///etc/passwd",
      "https://user:password@example.com",
      "javascript:alert(1)",
      "https://",
    ])
      expect(webFetchInput.safeParse({ url }).success).toBe(false);
    expect(
      webFetchInput.safeParse({ url: "https://example.com/article" }).success,
    ).toBe(true);
  });

  it("normalizes search results without leaking provider metadata and bounds content", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        results: [
          {
            title: "Title",
            url: "https://example.com",
            summary: "𠮷".repeat(2001),
            snippet: "Short",
            authority: 4,
            site_icon: "https://example.com/icon",
          },
        ],
      }),
    );
    const signal = new AbortController().signal;
    const client = createDeepSeekWebClient(
      "secret",
      "https://api.deepseek.com/v1/",
      request,
    );
    const results = await client.search(
      { query: "question", count: 5 },
      signal,
    );
    expect(request).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1/tools/search",
      expect.objectContaining({
        signal,
        body: JSON.stringify({
          query: "question",
          count: 5,
          need_content: false,
        }),
      }),
    );
    expect(results).toEqual([
      {
        title: "Title",
        url: "https://example.com",
        content: "𠮷".repeat(2000),
        truncated: true,
      },
    ]);
  });

  it("preserves empty searches and normalizes fetch truncation", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(
        Response.json({ title: "Page", content: "a".repeat(24001) }),
      );
    const client = createDeepSeekWebClient(
      "key",
      "https://api.deepseek.com",
      request,
    );
    expect(await client.search({ query: "no results", count: 5 })).toEqual([]);
    expect(await client.fetch("https://example.com")).toEqual({
      title: "Page",
      url: "https://example.com",
      content: "a".repeat(24000),
      truncated: true,
    });
    expect(request.mock.calls[1][0]).toBe(
      "https://api.deepseek.com/v1/tools/fetch",
    );
  });

  it.each([401, 402, 403, 404, 429, 500])(
    "does not echo errors or retry HTTP %s",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("secret credential", { status }));
      await expect(
        createDeepSeekWebClient(
          "secret",
          "https://api.deepseek.com",
          request,
        ).fetch("https://example.com"),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed results and unsafe source URLs", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              title: "Bad",
              url: "javascript:alert(1)",
              summary: "text",
              snippet: "",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ title: 1 }));
    const client = createDeepSeekWebClient(
      "key",
      "https://api.deepseek.com",
      request,
    );
    await expect(client.search({ query: "q", count: 5 })).rejects.toThrow(
      "invalid search response",
    );
    await expect(client.fetch("https://example.com")).rejects.toThrow(
      "invalid fetch response",
    );
  });

  it("does not start requests without credentials or after cancellation", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      createDeepSeekWebClient(null, "https://api.deepseek.com", request).fetch(
        "https://example.com",
      ),
    ).rejects.toThrow("API key");
    const controller = new AbortController();
    controller.abort();
    await expect(
      createDeepSeekWebClient("key", "https://api.deepseek.com", request).fetch(
        "https://example.com",
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
});
