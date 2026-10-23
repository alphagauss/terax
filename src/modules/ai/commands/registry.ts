/** 统一定义会话命令、别名和参数入口；不依赖 UI、模型 SDK 或具体宿主。 */
export type CommandSource =
  | { kind: "desktop" }
  | { kind: "channel"; platform: string };
export type CommandTranslator = (
  key: string,
  values?: Record<string, string>,
) => string;
export type CommandOutcome =
  | { kind: "reply"; text: string; error?: boolean }
  | { kind: "task"; prompt: string }
  | { kind: "compact" };
export type CommandContext = {
  sessionId: string;
  source: CommandSource;
  t: CommandTranslator;
  signal?: AbortSignal;
};
export type CommandDefinition = {
  name: string;
  aliases: readonly string[];
  descriptionKey: string;
  usage: string;
  scheduling: "immediate" | "idle";
  available: (source: CommandSource) => boolean;
  execute: (
    args: string,
    context: CommandContext,
  ) => CommandOutcome | Promise<CommandOutcome>;
};

const INIT_PROMPT = `Scan this workspace and create or update AGENTS.md at the workspace root with:

- One-paragraph project description.
- Build / test / dev commands.
- Architecture overview (subsystems, data flow, key dirs).
- Conventions worth knowing (naming, patterns, gotchas).
- Paths to entry points.

If AGENTS.md already exists, preserve valid project-specific instructions and update it surgically instead of replacing it blindly.

Use grep/find_files/read_file to explore, and read an existing AGENTS.md before editing it. Keep AGENTS.md under 200 lines. Use write_file mode=create for a new file, mode=rewrite for an intentionally complete replacement, or apply_patch for targeted updates.`;

function noArguments(
  args: string,
  usage: string,
  t: CommandTranslator,
): CommandOutcome | null {
  return args.trim()
    ? {
        kind: "reply",
        error: true,
        text: t("commands.invalidArguments", { usage }),
      }
    : null;
}

export const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "compact",
    aliases: [],
    descriptionKey: "commands.compactDescription",
    usage: "/compact",
    scheduling: "idle",
    available: () => true,
    execute: (args, { t }) =>
      noArguments(args, "/compact", t) ?? { kind: "compact" },
  },
  {
    name: "help",
    aliases: ["h"],
    descriptionKey: "commands.helpDescription",
    usage: "/help",
    scheduling: "immediate",
    available: () => true,
    execute: (args, { source, t }) =>
      noArguments(args, "/help", t) ?? {
        kind: "reply",
        text: [
          t("commands.supported"),
          ...availableCommands(source).map(
            (command) =>
              `${command.usage}${command.aliases.length ? ` (${command.aliases.map((alias) => `/${alias}`).join(", ")})` : ""}  ${t(command.descriptionKey)}`,
          ),
        ].join("\n"),
      },
  },
  {
    name: "init",
    aliases: [],
    descriptionKey: "commands.initDescription",
    usage: "/init",
    scheduling: "idle",
    available: () => true,
    execute: (args, { t }) =>
      noArguments(args, "/init", t) ?? { kind: "task", prompt: INIT_PROMPT },
  },
];

/** 名称与别名共用索引，重复注册立即失败。 */
const index = new Map<string, CommandDefinition>();
for (const command of COMMANDS) {
  for (const name of [command.name, ...command.aliases]) {
    if (index.has(name)) throw new Error(`Duplicate command: ${name}`);
    index.set(name, command);
  }
}

export function availableCommands(
  source: CommandSource,
): readonly CommandDefinition[] {
  return COMMANDS.filter((command) => command.available(source));
}

export type ParsedCommand = {
  raw: string;
  name: string;
  args: string;
  definition?: CommandDefinition;
};

/** 只解析开头的命令词，参数保持原文；路径、正文中的斜杠与片段不属于命令。 */
export function parseCommand(text: string): ParsedCommand | null {
  const raw = text.trimStart();
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+|$)/i.exec(raw);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return {
    raw: text,
    name,
    args: raw.slice(match[0].length),
    definition: index.get(name),
  };
}

export async function resolveCommand(
  command: ParsedCommand,
  context: CommandContext,
  hasAttachments = false,
): Promise<CommandOutcome> {
  const { source, t } = context;
  const definition = command.definition;
  if (!definition)
    return {
      kind: "reply",
      error: true,
      text: t("commands.unknown", { name: command.name }),
    };
  if (!definition.available(source))
    return {
      kind: "reply",
      error: true,
      text: t("commands.unavailable", { name: command.name }),
    };
  if (hasAttachments)
    return { kind: "reply", error: true, text: t("commands.noAttachments") };
  return definition.execute(command.args, context);
}
