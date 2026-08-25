#!/usr/bin/env bash
# 验证目录汇总任务不跟随符号链接，并返回稳定的文件、目录和逻辑大小统计。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/tree_summary.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

mkdir -p -- "$work/root/nested"
printf 'abc' >"$work/root/a.txt"
printf 'wxyz' >"$work/root/nested/b.txt"
ln -s -- "$work/root/nested" "$work/root/link"

target_path="$work/root" bash "$helper" >"$work/summary.txt"
grep -Fq 'TERAX_PROPERTIES_SCAN_V1 2 1 1 7 ' "$work/summary.txt"
