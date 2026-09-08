import { describe, expect, it } from "vitest";
import {
  normalizeAgentTools,
  resolveSubagentTools,
  setAgentToolEnabled,
} from "./agentTools";

describe("individual agent tools", () => {
  it("preserves an empty list, removes unknown IDs, and keeps stable order", () => {
    expect(normalizeAgentTools([])).toEqual([]);
    expect(
      normalizeAgentTools(["grep", "unknown", "read_file", "grep"]),
    ).toEqual(["read_file", "grep"]);
  });
  it("adds only the real editing dependency and removes dependants when unchecked", () => {
    expect(setAgentToolEnabled([], "write_file", true)).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(
      setAgentToolEnabled(
        ["read_file", "grep", "write_file", "apply_patch", "file_operation"],
        "read_file",
        false,
      ),
    ).toEqual(["grep", "file_operation"]);
    expect(setAgentToolEnabled([], "file_operation", true)).toEqual([
      "file_operation",
    ]);
  });
  it("narrows ask-mode subagents without adding search capabilities", () => {
    expect(
      resolveSubagentTools(
        ["read_file", "grep", "write_file", "shell_exec", "run_subagent"],
        "ask",
      ),
    ).toEqual(["read_file", "grep"]);
  });
  it("inherits full access without recursive delegation", () => {
    expect(
      resolveSubagentTools(
        ["read_file", "write_file", "shell_exec", "run_subagent"],
        "full-access",
      ),
    ).toEqual(["read_file", "write_file", "shell_exec"]);
  });
});
