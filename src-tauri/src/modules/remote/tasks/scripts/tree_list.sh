# Terax SSH 远端树枚举任务。
#
# 任务只读取目标树，不跟随符号链接，并用固定 NUL 协议返回物理根目录、类型、大小和
# 相对路径。调用方负责结果数量上限和排序。

set -eu

command -v find >/dev/null 2>&1 || exit 72
command -v readlink >/dev/null 2>&1 || exit 72
find /dev/null -maxdepth 0 -printf '' >/dev/null 2>&1 || exit 72

root=$(readlink -f -- "$target_path") || exit 73
[ -d "$root" ] || exit 73

printf 'TERAX_TREE_LIST_V1\000%s\000' "$root"

if [ "$show_hidden" = 1 ]; then
  find -P "$root" -mindepth 1 -maxdepth "$max_depth" \
    \( -type d \( \
      -name node_modules -o -name .git -o -name target -o -name dist -o \
      -name build -o -name .next -o -name .turbo -o -name .cache -o \
      -name .venv -o -name __pycache__ \
    \) -printf '%y\000%s\000%P\000' -prune \) -o \
    -printf '%y\000%s\000%P\000'
else
  find -P "$root" -mindepth 1 -maxdepth "$max_depth" \
    \( -name '.*' -prune \) -o \
    \( -type d \( \
      -name node_modules -o -name target -o -name dist -o -name build -o \
      -name .next -o -name .turbo -o -name .cache -o -name .venv -o \
      -name __pycache__ \
    \) -printf '%y\000%s\000%P\000' -prune \) -o \
    -printf '%y\000%s\000%P\000'
fi

printf 'END\000'
