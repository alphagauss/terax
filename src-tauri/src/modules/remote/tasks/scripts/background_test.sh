#!/usr/bin/env bash
# 验证后台日志与批量 PID 查询任务的分流协议和任意日志字节边界。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/background.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

printf 'before\000after\n' >"$work/process.log"
operation=logs process_id=$$ log_path="$work/process.log" start_offset=1 max_log_bytes=1024 \
  "$BASH" "$helper" >"$work/logs.bin" 2>"$work/logs.status"
cmp "$work/process.log" "$work/logs.bin"
grep -aFq 'running' "$work/logs.status"

printf '0123456789' >"$work/large.log"
operation=logs process_id=$$ log_path="$work/large.log" start_offset=1 max_log_bytes=4 \
  "$BASH" "$helper" >"$work/limited.bin" 2>"$work/limited.status"
[ "$(cat "$work/limited.bin")" = 0123 ]

operation=list process_ids="$$ 999999" "$BASH" "$helper" >"$work/list.bin"
grep -aFq "$$" "$work/list.bin"
grep -aFq 'running' "$work/list.bin"
grep -aFq '999999' "$work/list.bin"
grep -aFq 'exited' "$work/list.bin"
