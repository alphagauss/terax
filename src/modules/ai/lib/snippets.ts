import {
  deleteSharedStoreKey,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";

export type Snippet = {
  id: string;
  /** The "#handle" used in the composer. Lowercase, [a-z0-9-]+. */
  handle: string;
  name: string;
  description: string;
  content: string;
};

const snippetKey = (id: string) => `snippet:${id}`;

export async function loadSnippets(): Promise<Snippet[]> {
  const values = await readSharedStore("ai-snippets");
  const records = Object.entries(values)
    .filter(([key]) => key.startsWith("snippet:"))
    .map(([, value]) => value as Snippet);
  return records;
}

export function upsertSnippet(snippet: Snippet): Promise<void> {
  return setSharedStoreKey("ai-snippets", snippetKey(snippet.id), snippet);
}

export function deleteSnippet(id: string): Promise<void> {
  return deleteSharedStoreKey("ai-snippets", snippetKey(id));
}

export function newSnippetId(): string {
  return `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}

/** 从正文移除已知 `#handle`，并按首次出现顺序返回对应片段。 */
export function expandSnippetTokens(
  text: string,
  snippets: readonly Snippet[],
): { body: string; snippets: Snippet[] } {
  const byHandle = new Map(snippets.map((s) => [s.handle, s]));
  const matched = new Map<string, Snippet>();
  // (^|\s)#handle  — handle is [a-z0-9][a-z0-9-]*
  const re = /(^|\s)#([a-z0-9][a-z0-9-]*)\b/gi;
  const body = text.replace(re, (full, lead: string, raw: string) => {
    const h = raw.toLowerCase();
    const snip = byHandle.get(h);
    if (!snip) return full;
    matched.set(snip.id, snip);
    return lead;
  });
  return {
    body: body.replace(/[ \t]+\n/g, "\n").trim(),
    snippets: [...matched.values()],
  };
}
