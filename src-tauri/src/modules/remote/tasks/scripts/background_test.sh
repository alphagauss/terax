#!/usr/bin/env bash
# 验证后台 PID 批量查询任务的固定状态协议。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/background.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

operation=list process_ids="$$ 999999" "$BASH" "$helper" >"$work/list.bin"
grep -aFq "$$" "$work/list.bin"
grep -aFq 'running' "$work/list.bin"
grep -aFq '999999' "$work/list.bin"
grep -aFq 'exited' "$work/list.bin"
