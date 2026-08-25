# Terax SSH GNU grep 字面量搜索任务。
#
# find 在服务器本地筛选深度、隐藏目录和文件大小，grep 只返回文件名、行号和匹配行；
# 动态值均由 Rust 作为经过转义的变量赋值传入。

set -u

if [ "$probe_features" = 1 ]; then
  command -v find >/dev/null 2>&1 || exit 127
  command -v grep >/dev/null 2>&1 || exit 127
  command -v readlink >/dev/null 2>&1 || exit 127
  find /dev/null -maxdepth 0 -printf '' >/dev/null 2>&1 || exit 126
  readlink -f -- /dev/null >/dev/null 2>&1 || exit 126
  grep -F -i -w -n -H -Z -I -- TERAX_REMOTE_TASK_OPTION_PROBE /dev/null >/dev/null 2>&1
  probe_status=$?
  [ "$probe_status" -le 1 ] || exit 126
fi

root=$(readlink -f -- "$target_path") || exit 73
[ -d "$root" ] || exit 73
grep_options=(-F -n -H -Z -I)
[ "$ignore_case" = 0 ] || grep_options+=(-i)
[ "$whole_word" = 0 ] || grep_options+=(-w)

printf 'TERAX_GREP_CONTENT_V1\000%s\000' "$root"
find -P "$root" -mindepth 1 -maxdepth "$max_depth" \
  \( -name '.*' -prune \) -o \
  \( -type d \( \
    -name node_modules -o -name target -o -name dist -o -name build -o \
    -name .next -o -name .turbo -o -name .cache -o -name .venv -o \
    -name __pycache__ \
  \) -prune \) -o \
  \( -type f -size "-$((max_size + 1))c" \
    -exec grep "${grep_options[@]}" -- "$pattern" {} + \)
