#!/usr/bin/env bash
# 验证目录创建任务的嵌套父链、已存在目标和符号链接父目录语义。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/create_directory.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

target_path="$work/a/b/c" bash "$helper" >"$work/created.bin"
test -d "$work/a/b/c"
grep -aFq 'created' "$work/created.bin"

target_path="$work/a/b/c" bash "$helper" >"$work/exists.bin"
grep -aFq 'exists' "$work/exists.bin"

mkdir -p -- "$work/real"
ln -s -- "$work/real" "$work/link"
target_path="$work/link/nested" bash "$helper" >"$work/link.bin"
test -d "$work/real/nested"
grep -aFq 'created' "$work/link.bin"
