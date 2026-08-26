/**
 * 本文件定义输入框支持的斜杠命令及其解析规则。
 * 命令只生成受普通工具审批约束的提示词，不直接执行写操作。
 */

import { SparklesIcon } from "@hugeicons/core-free-icons";

/** 斜杠命令解析结果：改写为提示词或保持普通输入。 */
export type SlashOutcome =
  | { kind: "send-prompt"; prompt: string; commandName?: string }
  | { kind: "none" };

const INIT_PROMPT = `Scan this workspace and create or update AGENTS.md at the workspace root with:

- One-paragraph project description.
- Build / test / dev commands.
- Architecture overview (subsystems, data flow, key dirs).
- Conventions worth knowing (naming, patterns, gotchas).
- Paths to entry points.

If AGENTS.md already exists, preserve valid project-specific instructions and update it surgically instead of replacing it blindly.

Use grep/find_files/read_file to explore. Cap AGENTS.md under 200 lines. Use write_file mode=create for a new file, mode=rewrite for an intentionally complete replacement, or apply_patch for targeted updates. All mutations use the normal approval flow.`;

export type SlashCommandMeta = {
  name: string;
  invocation: string;
  label: string;
  icon: typeof SparklesIcon;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  init: {
    name: "init",
    invocation: "/init",
    label: "Initialize workspace",
    icon: SparklesIcon,
  },
};

export const TERAX_CMD_RE =
  /^<terax-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

/**
 * 解析并执行输入框中的斜杠命令或命令选择器标记。
 *
 * `/init` 会转换为生成 AGENTS.md 的工作区扫描提示词，其他普通输入保持不变。
 */
export function tryRunSlashCommand(input: string): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [head] = trimmed.slice(1).split(/\s+/);
  if (lead === "#" && !SLASH_COMMANDS[head]) return { kind: "none" };

  switch (head) {
    case "init": {
      return {
        kind: "send-prompt",
        prompt: INIT_PROMPT,
        commandName: "init",
      };
    }
    default:
      return { kind: "none" };
  }
}
