#!/usr/bin/env bash
# 验证文件版本任务的缺失、稳定摘要、大小限制和符号链接语义。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/file_version.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

target_path="$work/missing.txt" max_size=1024 probe_features=1 "$BASH" "$helper" >"$work/missing.bin"
grep -aFq 'missing' "$work/missing.bin"

printf 'payload' >"$work/file.txt"
target_path="$work/file.txt" max_size=1024 probe_features=1 "$BASH" "$helper" >"$work/version.bin"
grep -aFq 'version' "$work/version.bin"
grep -aFq '7' "$work/version.bin"

ln -s -- "$work/file.txt" "$work/link.txt"
target_path="$work/link.txt" max_size=1024 probe_features=1 "$BASH" "$helper" >"$work/link.bin"
cmp "$work/version.bin" "$work/link.bin"

target_path="$work/file.txt" max_size=3 probe_features=1 "$BASH" "$helper" >"$work/toolarge.bin"
grep -aFq 'toolarge' "$work/toolarge.bin"
