# 每个输出使用长度帧，不用命令替换保存可能含 NUL 的 Git 输出。
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= GIT_OPTIONAL_LOCKS=0 GCM_INTERACTIVE=Never LC_ALL=C
cd -- "$target" || exit 1
temp_dir=$(mktemp -d) || exit 1
trap 'rm -rf -- "$temp_dir"' 0

emit() {
  frame_name=$1
  shift
  # 多保留一个字节识别截断，并排空剩余输出；退出状态经独立文件保留，兼容 POSIX sh。
  { "$@" </dev/null 2>"$temp_dir/err"; printf '%s' "$?" >"$temp_dir/code"; } |
    { head -c 2097153 >"$temp_dir/out"; cat >/dev/null; }
  IFS= read -r last_code <"$temp_dir/code" || :
  printf '%s\0%s\0%s\0%s\0' "$frame_name" "$last_code" "$(wc -c <"$temp_dir/out")" "$(wc -c <"$temp_dir/err")"
  cat -- "$temp_dir/out" "$temp_dir/err"
}

case $mode in
snapshot)
  emit root git rev-parse --show-toplevel
  [ "$last_code" = 0 ] || exit 0
  emit status git status --porcelain=v2 --find-renames=50% --branch -z --untracked-files=all
  [ "$last_code" = 0 ] || exit 0
  if [ "$graph" = 1 ]; then
    emit refs git show-ref --head --dereference
    emit symbolic git rev-parse --symbolic-full-name HEAD '@{upstream}'
  fi
  ;;
action)
  case $action in
    fetch) emit action git fetch --prune ;;
    pull) emit action git pull --ff-only --prune ;;
    push)
      emit upstream git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
      [ "$last_code" = 0 ] || exit 0
      emit action git push
      ;;
  esac
  ;;
history)
  emit remote git remote
  emit branch git symbolic-ref --quiet --short HEAD
  emit upstream git rev-parse --symbolic-full-name '@{upstream}'
  # 依赖值直接从同一批次的输出读取，不额外建立远端请求。
  upstream=
  if [ "$last_code" = 0 ]; then
    IFS= read -r upstream <"$temp_dir/out" || :
  fi
  set -- HEAD
  [ -z "$upstream" ] || set -- "$@" "$upstream"
  emit log git log --no-color --topo-order --ignore-missing --max-count="$limit" --skip="$skip" --format="$history_format" "$@" --
  ;;
statistics)
  emit worktree git diff --numstat -z --find-renames=50% --no-ext-diff --no-textconv
  emit index git diff --numstat -z --find-renames=50% --no-ext-diff --no-textconv --cached
  root=$(pwd -P) || exit 1
  root=${root%/}
  for path do
    # 未跟踪文件只在执行环境内统计；拒绝链接越界、末级符号链接和过大文件。
    case $path in */*) parent=${path%/*} ;; *) parent=. ;; esac
    parent=$(cd -P -- "$parent" && pwd -P) || parent=
    case $parent in "$root"|"$root"/*) inside=1 ;; *) inside=0 ;; esac
    if [ "$inside" = 0 ] || [ -L "$path" ] || [ ! -f "$path" ] || ! size=$(stat -c %s -- "$path") || [ "$size" -gt 2097152 ]; then
      emit "untracked:$path" false
    else
      emit "untracked:$path" git diff --no-index --numstat -z --no-ext-diff --no-textconv -- /dev/null "$path"
    fi
  done
  ;;
esac
