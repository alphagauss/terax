# 每个输出使用长度帧，不用命令替换保存可能含 NUL 的 Git 输出。
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= GIT_OPTIONAL_LOCKS=0 GCM_INTERACTIVE=Never LC_ALL=C
cd -- "$target" || exit 1
temp_dir=$(mktemp -d) || exit 1
trap 'rm -rf -- "$temp_dir"' EXIT

emit() {
  local name=$1
  shift
  # 多保留一个字节供公共解析层识别截断，剩余输出排空，避免占满临时磁盘。
  "$@" 2>"$temp_dir/err" | { head -c 2097153 >"$temp_dir/out"; cat >/dev/null; }
  last_code=${PIPESTATUS[0]}
  printf '%s\0%s\0%s\0%s\0' "$name" "$last_code" "$(wc -c <"$temp_dir/out")" "$(wc -c <"$temp_dir/err")"
  cat -- "$temp_dir/out" "$temp_dir/err"
}

if [[ $mode == snapshot ]]; then
  emit root git rev-parse --show-toplevel
  [[ $last_code == 0 ]] || exit 0
  emit status git status --porcelain=v2 --find-renames=50% --branch -z --untracked-files=all
  [[ $last_code == 0 ]] || exit 0
  if [[ $graph == 1 ]]; then
    emit refs git show-ref --head --dereference
    emit symbolic git rev-parse --symbolic-full-name HEAD '@{upstream}'
  fi
else
  emit worktree git diff --numstat -z --find-renames=50% --no-ext-diff --no-textconv
  emit index git diff --numstat -z --find-renames=50% --no-ext-diff --no-textconv --cached
  for path in "${paths[@]}"; do
    # 未跟踪文件只在服务器统计，不下载正文；拒绝末级符号链接和过大文件。
    if [[ -L $path || ! -f $path ]] || ! size=$(stat -c %s -- "$path") || (( size > 2097152 )); then
      emit "untracked:$path" false
    else
      emit "untracked:$path" git diff --no-index --numstat -z --no-ext-diff --no-textconv -- /dev/null "$path"
    fi
  done
fi
