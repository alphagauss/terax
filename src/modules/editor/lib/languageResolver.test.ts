/**
 * 本文件测试编辑器语言解析与解析器加载。
 * 重点锁定特殊文件名、扩展名边界以及框架专用语言模式。
 */

import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./languageResolver";

describe("resolveLanguage", () => {
  it("resolves real extensions", async () => {
    await expect(resolveLanguage("App.tsx")).resolves.toMatchObject({
      name: "TypeScript React",
    });
    await expect(resolveLanguage("main.go")).resolves.toMatchObject({
      name: "Go",
    });
    await expect(resolveLanguage("README.md")).resolves.toMatchObject({
      name: "Markdown",
    });
  });

  it("strips directories before resolving", async () => {
    await expect(
      resolveLanguage("/Users/foo/src/index.ts"),
    ).resolves.toMatchObject({ name: "TypeScript" });
    await expect(
      resolveLanguage("C:\\proj\\Dockerfile.prod"),
    ).resolves.toMatchObject({ name: "Dockerfile" });
  });

  it("matches fixed filenames", async () => {
    await expect(resolveLanguage("Dockerfile")).resolves.toMatchObject({
      name: "Dockerfile",
    });
    await expect(resolveLanguage(".env")).resolves.toMatchObject({
      name: "Dotenv",
    });
    await expect(resolveLanguage(".eslintrc")).resolves.toMatchObject({
      name: "JSON",
    });
  });

  // Regression: removing isDockerfileLike dropped highlighting for Dockerfile
  // variants. The name-scoped prefix fallback restores it generically.
  it("resolves filename-prefix variants of name-based languages", async () => {
    await expect(resolveLanguage("Dockerfile.web")).resolves.toMatchObject({
      name: "Dockerfile",
    });
    await expect(resolveLanguage(".env.local")).resolves.toMatchObject({
      name: "Dotenv",
    });
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
  it("does not let extension languages capture prefix lookalikes", async () => {
    await expect(resolveLanguage("go.sum")).resolves.toBeNull();
    await expect(resolveLanguage("go.mod")).resolves.toBeNull();
    await expect(resolveLanguage("json.backup")).resolves.toBeNull();
  });

  it("returns null for unknown files", async () => {
    await expect(resolveLanguage("notes")).resolves.toBeNull();
  });
});
