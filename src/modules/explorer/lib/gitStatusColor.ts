/**
 * 本文件定义资源管理器与源代码管理文件列表共用的 Git 状态颜色。
 * 仅负责状态到主题语义色的映射，不绑定具体主题配色。
 */

/** 返回 Git 状态对应的主题语义文字颜色类。 */
export function explorerGitTextClass(code: string): string {
  switch (code) {
    case "M":
      return "text-git-modified";
    case "A":
      return "text-git-added";
    case "U":
      return "text-git-untracked";
    case "R":
    case "C":
      return "text-git-renamed";
    case "D":
      return "text-git-deleted";
    default:
      return "text-muted-foreground";
  }
}
