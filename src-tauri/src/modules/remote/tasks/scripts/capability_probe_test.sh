#!/usr/bin/env bash
# 验证统一能力探测始终返回完整、唯一且可解析的命令状态协议。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output=$(mktemp)
lines=$(mktemp)
errors=$(mktemp)
probe_root=$(mktemp -d)
trap 'rm -f -- "$output" "$lines" "$errors"; rm -rf -- "$probe_root"' EXIT

TMPDIR=$probe_root "$BASH" "$script_dir/capability_probe.sh" >"$output" 2>"$errors"
tr '\000' '\n' <"$output" >"$lines"
[ ! -s "$errors" ]
[ "$(sed -n '1p' "$lines")" = TERAX_CAPABILITIES_V1 ]
[ "$(tail -n 1 "$lines")" = END ]
[ -z "$(find "$probe_root" -mindepth 1 -maxdepth 1 -print -quit)" ]

for id in bash setsid find readlink stat awk rm mktemp mkdir chmod dd mv ln sha256 \
  rg_content rg_files grep; do
  [ "$(grep -cx "$id" "$lines")" -eq 1 ]
done

capability_state() {
  awk -v id="$1" '$0 == id { getline; print; exit }' "$lines"
}

is_gnu_coreutils() {
  local version
  version=$("$1" --version 2>/dev/null) || return 1
  case $version in
    *"GNU coreutils"*) return 0 ;;
    *) return 1 ;;
  esac
}

if is_gnu_coreutils chmod && is_gnu_coreutils dd &&
  is_gnu_coreutils mv && is_gnu_coreutils ln; then
  for id in chmod dd mv ln; do
    [ "$(capability_state "$id")" = ready ]
  done
fi
