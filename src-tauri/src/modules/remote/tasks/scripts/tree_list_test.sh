#!/usr/bin/env bash
# 验证远端树任务的隐藏项、固定剪枝、空格路径和符号链接边界。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/tree_list.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

root="$work/project with space"
mkdir -p -- "$root/src" "$root/node_modules/pkg" "$root/.hidden"
printf 'main' >"$root/src/main.rs"
printf 'ignored' >"$root/node_modules/pkg/index.js"
printf 'hidden' >"$root/.hidden/secret.txt"
ln -s -- "$root/src" "$root/src-link"

target_path=$root show_hidden=0 max_depth=8 bash "$helper" >"$work/visible.bin"
grep -aFq 'TERAX_TREE_LIST_V1' "$work/visible.bin"
grep -aFq 'src/main.rs' "$work/visible.bin"
grep -aFq 'node_modules' "$work/visible.bin"
grep -aFq 'src-link' "$work/visible.bin"
if grep -aFq 'node_modules/pkg/index.js' "$work/visible.bin"; then
  printf 'pruned directory contents leaked\n' >&2
  exit 1
fi
if grep -aFq '.hidden/secret.txt' "$work/visible.bin"; then
  printf 'hidden entry leaked\n' >&2
  exit 1
fi

target_path=$root show_hidden=1 max_depth=8 bash "$helper" >"$work/hidden.bin"
grep -aFq '.hidden/secret.txt' "$work/hidden.bin"
