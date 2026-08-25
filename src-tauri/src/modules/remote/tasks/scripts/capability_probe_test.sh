#!/usr/bin/env bash
# 验证统一能力探测始终返回完整、唯一且可解析的命令状态协议。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output=$(mktemp)
lines=$(mktemp)
trap 'rm -f -- "$output" "$lines"' EXIT

"$BASH" "$script_dir/capability_probe.sh" >"$output"
tr '\000' '\n' <"$output" >"$lines"
[ "$(sed -n '1p' "$lines")" = TERAX_CAPABILITIES_V1 ]
[ "$(tail -n 1 "$lines")" = END ]

for id in bash find readlink stat awk rm mktemp mkdir chmod dd mv ln sha256 \
  rg_content rg_files grep; do
  [ "$(grep -cx "$id" "$lines")" -eq 1 ]
done
