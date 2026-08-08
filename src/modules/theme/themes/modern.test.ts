/**
 * 本文件测试 Modern 主题的 Git 状态语义色。
 * 锁定明暗模式与 VS Code Git decoration 默认配色的对应关系。
 */

import { describe, expect, it } from "vitest";
import { darkModernVariant, lightModernVariant } from "./modern";

describe("Modern Git status colors", () => {
  it("uses the VS Code Light Modern colors", () => {
    expect(lightModernVariant.colors).toMatchObject({
      gitModified: "#895503",
      gitAdded: "#587C0C",
      gitUntracked: "#007100",
      gitRenamed: "#007100",
      gitDeleted: "#AD0707",
      editorGitModified: "#2472C8",
      editorGitAdded: "#0DBC79",
      editorGitDeleted: "#CD3131",
    });
  });

  it("uses the VS Code Dark Modern colors", () => {
    expect(darkModernVariant.colors).toMatchObject({
      gitModified: "#E2C08D",
      gitAdded: "#81B88B",
      gitUntracked: "#73C991",
      gitRenamed: "#73C991",
      gitDeleted: "#C74E39",
      editorGitModified: "#0451A5",
      editorGitAdded: "#107C10",
      editorGitDeleted: "#CD3131",
    });
  });
});
