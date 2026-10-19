/** DeepSeek Search/Fetch 适配；复用原生传输、独立超时与调用取消，不执行本地网页抓取。 */
import { createHttpFetch } from "@/lib/http";
import { z } from "zod";
import { isWebUrl, type WebClient, type WebResult } from "./types";

const pageSchema = z.object({ title: z.string(), content: z.string() });
const searchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().refine(isWebUrl),
      summary: z.string(),
      snippet: z.string(),
    }),
  ),
});

function result(
  title: string,
  url: string,
  content: string,
  limit: number,
): WebResult {
  const characters = Array.from(content);
  return {
    title: Array.from(title).slice(0, 500).join(""),
    url,
    content: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}

export function createDeepSeekWebClient(
  apiKey: string | null,
  baseURL: string,
  request: typeof fetch = createHttpFetch({
    networkTarget: { kind: "provider", id: "builtin:deepseek" },
    timeoutMs: 30_000,
    maxResponseBytes: 2 * 1024 * 1024,
  }),
): WebClient {
  const base = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
  async function post(
    operation: "search" | "fetch",
    body: unknown,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!apiKey?.trim())
      throw new Error(
        "Configure the DeepSeek API key in Models settings to use web tools.",
      );
    const response = await request(`${base}/v1/tools/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      // 不回显服务端正文，避免上游错误夹带凭据或整段用户查询。
      throw new Error(
        `DeepSeek ${operation} failed (HTTP ${response.status}).${[408, 429].includes(response.status) || response.status >= 500 ? " Retry later." : " Check the request, credentials and account balance before retrying."}`,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      signal?.throwIfAborted();
      throw new Error(`DeepSeek returned an unreadable ${operation} response.`);
    }
    signal?.throwIfAborted();
    return data;
  }
  return {
    async search(input, signal) {
      const data = searchSchema.safeParse(
        await post("search", { ...input, need_content: false }, signal),
      );
      if (!data.success)
        throw new Error("DeepSeek returned an invalid search response.");
      return data.data.results
        .slice(0, input.count)
        .map((page) =>
          result(page.title, page.url, page.summary || page.snippet, 2000),
        );
    },
    async fetch(url, signal) {
      const data = pageSchema.safeParse(await post("fetch", { url }, signal));
      if (!data.success)
        throw new Error("DeepSeek returned an invalid fetch response.");
      return result(data.data.title, url, data.data.content, 24000);
    },
  };
}
