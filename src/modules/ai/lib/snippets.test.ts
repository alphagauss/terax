import { describe, expect, it } from "vitest";
import {
  expandSnippetTokens,
  isValidHandle,
  normalizeHandle,
  type Snippet,
} from "./snippets";

function snippet(
  over: Partial<Snippet> & Pick<Snippet, "id" | "handle">,
): Snippet {
  return { name: "", description: "", content: "", ...over };
}

describe("normalizeHandle", () => {
  it("lowercases and hyphenates whitespace", () => {
    expect(normalizeHandle("Hello World")).toBe("hello-world");
  });

  it("drops characters outside [a-z0-9-]", () => {
    expect(normalizeHandle("My Cool Snippet!!")).toBe("my-cool-snippet");
  });

  it("collapses repeated hyphens and trims leading/trailing ones", () => {
    expect(normalizeHandle("--a--b--")).toBe("a-b");
  });
});

describe("isValidHandle", () => {
  it("accepts lowercase alphanumeric handles", () => {
    expect(isValidHandle("foo-bar")).toBe(true);
    expect(isValidHandle("a")).toBe(true);
  });

  it("rejects empty, leading-hyphen, and uppercase handles", () => {
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("-x")).toBe(false);
    expect(isValidHandle("Foo")).toBe(false);
  });
});

describe("expandSnippetTokens", () => {
  const snippets = [
    snippet({ id: "1", handle: "greet", content: "Hello" }),
    snippet({ id: "2", handle: "bye", content: "Goodbye" }),
  ];

  it("removes a known token and returns its snippet", () => {
    const { body, snippets: matched } = expandSnippetTokens(
      "#greet now",
      snippets,
    );
    expect(body).toBe("now");
    expect(matched).toEqual([snippets[0]]);
  });

  it("matches handles case-insensitively", () => {
    const { body, snippets: matched } = expandSnippetTokens(
      "do #GREET please",
      snippets,
    );
    expect(body).not.toContain("#GREET");
    expect(matched).toEqual([snippets[0]]);
  });

  it("expands multiple distinct tokens in order", () => {
    const { snippets: matched } = expandSnippetTokens(
      "#greet and #bye",
      snippets,
    );
    expect(matched).toEqual(snippets);
  });

  it("emits a repeated snippet only once", () => {
    const { snippets: matched } = expandSnippetTokens(
      "#greet #greet",
      snippets,
    );
    expect(matched).toEqual([snippets[0]]);
  });

  it("leaves unknown tokens untouched", () => {
    const { body, snippets: matched } = expandSnippetTokens(
      "say #missing ok",
      snippets,
    );
    expect(body).toBe("say #missing ok");
    expect(matched).toEqual([]);
  });

  it("does not expand a token glued to a preceding word", () => {
    const { body, snippets: matched } = expandSnippetTokens(
      "email#greet",
      snippets,
    );
    expect(body).toBe("email#greet");
    expect(matched).toEqual([]);
  });
});
