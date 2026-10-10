import { currentWorkspaceEnv } from "@/modules/workspace";
import { type Completion, startCompletion } from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";

type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

function joinRel(cwd: string, rel: string): string {
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const clean = rel.replace(/\/$/, "");
  return clean ? `${base}/${clean}` : base;
}

function resolveDir(dirPart: string, cwd: string): string | null {
  if (dirPart.startsWith("~")) return null;
  if (dirPart.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dirPart))
    return dirPart;
  return joinRel(cwd, dirPart);
}

/** 完整替换路径 token，避免空格或引号被 Shell 拆成其他参数。 */
export function quoteCompletionPath(path: string, powershell: boolean): string {
  if ((powershell ? /^[\w.:/\\-]+$/ : /^[\w.:/-]+$/).test(path)) return path;
  return powershell
    ? `'${path.replace(/'/g, "''")}'`
    : `'${path.replace(/'/g, "'\\''")}'`;
}

// Completes the argument token against the terminal's live cwd. Directories get
// a trailing slash and re-trigger completion so the next level opens on accept.
export async function pathCompletions(
  token: string,
  cwd: string,
  powershell = false,
): Promise<Completion[] | null> {
  const raw = token.startsWith("'")
    ? token.slice(1).replace(/'$/, "").replace(/''/g, "'")
    : token;
  const path = powershell ? raw.replace(/\\/g, "/") : raw;
  const slash = path.lastIndexOf("/");
  const dirPart = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = resolveDir(dirPart, cwd);
  if (!dir) return null;

  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("fs_read_dir", {
      path: dir,
      showHidden: base.startsWith("."),
      workspace: currentWorkspaceEnv(),
    });
  } catch {
    return null;
  }

  const lower = base.toLowerCase();
  const dirs: Completion[] = [];
  const files: Completion[] = [];
  for (const e of entries) {
    if (lower && !e.name.toLowerCase().startsWith(lower)) continue;
    const isDir = e.kind === "dir";
    const option: Completion = {
      label: `${e.name}${isDir ? "/" : ""}`,
      type: isDir ? "type" : "variable",
      apply: (view, _completion, from, to) => {
        const full = `${dirPart}${e.name}${isDir ? "/" : ""}`;
        const insert = quoteCompletionPath(full, powershell);
        const end =
          token.startsWith("'") &&
          view.state.doc.sliceString(to, to + 1) === "'"
            ? to + 1
            : to;
        view.dispatch({
          changes: { from, to: end, insert },
          selection: {
            anchor:
              from + insert.length - (isDir && insert.endsWith("'") ? 1 : 0),
          },
        });
        if (isDir) startCompletion(view);
      },
    };
    (isDir ? dirs : files).push(option);
    if (dirs.length + files.length >= 200) break;
  }

  return [...dirs, ...files];
}
