/**
 * 本文件实现基于会话固定目录的 grep 与 glob 搜索工具。
 * 搜索结果仍经过秘密路径拒绝规则过滤。
 */

import { tool } from "ai";
import { z } from "zod";
import { searchContent } from "@/modules/workspace-search/api";
import { native } from "../lib/native";
import { checkReadable, checkReadableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

function resolveRoot(
  rawRoot: string | undefined,
  ctx: ToolContext,
): { ok: true; path: string } | { ok: false; error: string } {
  if (rawRoot && rawRoot.trim().length > 0) {
    try {
      return { ok: true, path: resolvePath(rawRoot, ctx.getCwd()) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return { ok: true, path: ctx.getCwd() };
}

const MAX_LINE_LEN = 160;

function clipLine(s: string): string {
  if (s.length <= MAX_LINE_LEN) return s;
  return `${s.slice(0, MAX_LINE_LEN)}…[+${s.length - MAX_LINE_LEN}]`;
}

function pathForSafety(path: string, root: string): string {
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return path;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.endsWith(sep) ? `${root}${path}` : `${root}${sep}${path}`;
}

function isReadableSearchHit(path: string, root: string): boolean {
  return checkReadable(pathForSafety(path, root)).ok;
}

export function buildSearchTools(ctx: ToolContext) {
  return {
    grep: tool({
      description:
        "Search file contents in the workspace using a regular expression. Honors .gitignore. Returns up to `max_results` (default 30, max 500) `{path, line, text}` hits, with a `truncated` flag when more existed. Long match lines are clipped to 160 chars. Use this for code navigation — do NOT brute-force read_file across the tree. Narrow with `glob` when you can; raise `max_results` only if the first batch truly isn't enough.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "Regex pattern (Rust ripgrep dialect). Anchor and escape literal characters as needed.",
          ),
        root: z
          .string()
          .optional()
          .describe(
            "Root to search under. Defaults to the session working directory.",
          ),
        glob: z
          .array(z.string())
          .optional()
          .describe(
            "Optional include-globs over relative paths, e.g. ['**/*.ts', 'src/**/*.tsx'].",
          ),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().min(1).max(500).optional(),
      }),
      execute: async ({
        pattern,
        root,
        glob,
        case_insensitive,
        max_results,
      }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(
          r.path,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        const cap = Math.min(max_results ?? 30, 500);
        try {
          const res = await searchContent({
            pattern,
            root: r.path,
            syntax: "regex",
            caseMode: case_insensitive ? "insensitive" : "sensitive",
            wholeWord: false,
            includes: glob,
            maxResults: cap,
          });
          const hits = res.hits.filter((h) =>
            isReadableSearchHit(h.path, r.path),
          );
          return {
            root: r.path,
            hits: hits.map((h) => ({
              path: h.path,
              rel: h.rel,
              line: h.line,
              text: clipLine(h.text),
            })),
            truncated: res.truncated,
            files_scanned: res.filesScanned,
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),

    glob: tool({
      description:
        "Find files by path pattern (gitignore-aware). Use over `list_directory` when you want all matches recursively. Patterns use globset syntax: `**/*.ts`, `src/**/test_*.py`. Returns up to `max_results` matches.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern over relative paths."),
        root: z.string().optional(),
        max_results: z.number().int().min(1).max(2000).optional(),
      }),
      execute: async ({ pattern, root, max_results }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(
          r.path,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        try {
          const res = await native.glob({
            pattern,
            root: r.path,
            maxResults: max_results,
          });
          return {
            root: r.path,
            hits: res.hits.filter((h) => isReadableSearchHit(h.path, r.path)),
            truncated: res.truncated,
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),
  } as const;
}
