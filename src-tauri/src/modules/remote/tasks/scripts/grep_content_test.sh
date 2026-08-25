#!/usr/bin/env bash
# 验证 GNU grep fallback 的 NUL 文件名协议、隐藏过滤、大小限制和匹配选项。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/grep_content.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

mkdir -p "$work/root/src" "$work/root/.hidden" "$work/root/node_modules/pkg"
printf 'Alpha needle\nsecond needle\n' >"$work/root/src/a file.txt"
printf 'needle\n' >"$work/root/.hidden/secret.txt"
printf 'needle\n' >"$work/root/node_modules/pkg/ignored.txt"
printf 'needle in a large file\n' >"$work/root/large.txt"

target_path="$work/root" pattern=needle ignore_case=0 whole_word=1 max_depth=8 \
  max_size=20 probe_features=1 "$BASH" "$helper" >"$work/output.bin"
grep -aFq 'TERAX_GREP_CONTENT_V1' "$work/output.bin"
grep -aFq 'a file.txt' "$work/output.bin"
! grep -aFq 'secret.txt' "$work/output.bin"
! grep -aFq 'ignored.txt' "$work/output.bin"
! grep -aFq 'large.txt' "$work/output.bin"
