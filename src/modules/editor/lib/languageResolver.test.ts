/**
 * 本文件测试编辑器语言解析与解析器加载。
 * 重点锁定特殊文件名、扩展名边界以及框架专用语言模式。
 */

import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { resolveDisplayName, resolveLanguage } from "./languageResolver";

describe("resolveDisplayName", () => {
  it("resolves real extensions", () => {
    expect(resolveDisplayName("App.tsx")).toBe("TypeScript React");
    expect(resolveDisplayName("main.go")).toBe("Go");
    expect(resolveDisplayName("README.md")).toBe("Markdown");
    expect(resolveDisplayName("query.sql")).toBe("SQL");
    expect(resolveDisplayName("Component.svelte")).toBe("Svelte");
  });

  it("strips directories before resolving", () => {
    expect(resolveDisplayName("/Users/foo/src/index.ts")).toBe("TypeScript");
    expect(resolveDisplayName("C:\\proj\\Dockerfile.prod")).toBe("Dockerfile");
  });

  it("matches fixed filenames", () => {
    expect(resolveDisplayName("Dockerfile")).toBe("Dockerfile");
    expect(resolveDisplayName(".env")).toBe("Dotenv");
    expect(resolveDisplayName(".eslintrc")).toBe("JSON");
  });

  // Regression: removing isDockerfileLike dropped highlighting for Dockerfile
  // variants. The name-scoped prefix fallback restores it generically.
  it("resolves filename-prefix variants of name-based languages", () => {
    expect(resolveDisplayName("Dockerfile.web")).toBe("Dockerfile");
    expect(resolveDisplayName("Dockerfile.dev")).toBe("Dockerfile");
    expect(resolveDisplayName("web.dockerfile")).toBe("Dockerfile");
    expect(resolveDisplayName(".env.local")).toBe("Dotenv");
    expect(resolveDisplayName(".env.production.local")).toBe("Dotenv");
    expect(resolveDisplayName("example.env")).toBe("Dotenv");
  });

  it("loads dotenv files with their language mode", async () => {
    const result = await resolveLanguage("/project/.env.local");
    expect(result?.name).toBe("Dotenv");
    expect(result?.id).toBe("env");
    expect(result?.ext).toBeTruthy();
  });

  it("使用专用语言模式解析 Svelte 文件", async () => {
    const result = await resolveLanguage("/project/Component.svelte");
    if (!result) throw new Error("无法加载 Svelte 语言模式");

    expect(result.name).toBe("Svelte");
    expect(result.id).toBe("svelte");

    const state = EditorState.create({
      doc: "{#if ready}<button on:click={run}>{label}</button>{/if}",
      extensions: [result.ext],
    });
    const tree = syntaxTree(state).toString();
    expect(tree).toContain("IfBlock");
    expect(tree).toContain("DirectiveOn");
  });

  // The prefix fallback must not let extension languages capture lookalike
  // files: `go.sum` / `go.mod` are not Go, `json.backup` is not JSON.
  it("does not let extension languages capture prefix lookalikes", () => {
    expect(resolveDisplayName("go.sum")).not.toBe("Go");
    expect(resolveDisplayName("go.mod")).not.toBe("Go");
    expect(resolveDisplayName("json.backup")).not.toBe("JSON");
  });

  it("falls back to a capitalized basename for unknown files", () => {
    expect(resolveDisplayName("notes")).toBe("Notes");
    expect(resolveDisplayName(null)).toBe("Plain Text");
    expect(resolveDisplayName("")).toBe("Plain Text");
  });
});
