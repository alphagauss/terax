# 在独立 Bash 或 Zsh 中运行，验证块模式保留提示符且不重复注入边界。
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export TERAX_BLOCKS=1
if [ -n "$ZSH_VERSION" ]; then
  source <(tr -d '\r' < "$script_dir/zshrc.zsh") >/dev/null
else
  source <(tr -d '\r' < "$script_dir/bashrc.bash") >/dev/null
fi

PS1='user@host:project$ '
RPROMPT='right-prompt'
for iteration in 1 2; do
  rendered=$(_terax_precmd)
  # 子进程不保留 PS1 修改，再在当前 Shell 调用以检验真实提示符。
  _terax_precmd >/dev/null
  case "$PS1" in
    *'133;B'*'133;B'*) echo '提示符标记重复' >&2; exit 1 ;;
    *'133;B'*) ;;
    *) echo '缺少提示符标记' >&2; exit 1 ;;
  esac
  case "$PS1" in
    *'user@host:project$ '*) ;;
    *) echo '块模式丢失用户提示符' >&2; exit 1 ;;
  esac
  [ "$RPROMPT" = 'right-prompt' ] || exit 1
  case "$rendered" in
    *$'\033\\\n'*'133;A'*) ;;
    *) echo '提示符未与上一条输出分行' >&2; exit 1 ;;
  esac
  # 模拟主题或用户命令在运行中替换提示符，下一次仍须补上标记。
  PS1='user@host:project$ '
done
printf '%s\n' 'Shell prompt tests passed'
