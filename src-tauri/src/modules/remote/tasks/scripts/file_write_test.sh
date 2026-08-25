#!/usr/bin/env bash
# Bash 文件写入任务的独立语义测试。
#
# 测试锁定条件写入、冲突、缺失创建、覆盖和权限保留，不依赖 SSH 或仓库运行时。

set -euo pipefail

helper=${BASH_SOURCE[0]%/*}/file_write.sh
root=$(mktemp -d)
trap 'rm -rf -- "$root"' EXIT HUP INT TERM

terax_revision() {
  sha256sum | cut -d ' ' -f 1
}

terax_run() {
  local operation=$1 target_path=$2 body=$3 expected_revision=${4-} expected_size=${5-0}
  printf '%s' "$body" >"$root/request"
  terax_run_file "$operation" "$target_path" "$root/request" "$expected_revision" "$expected_size"
}

terax_run_file() {
  local operation=$1 target_path=$2 body_path=$3 expected_revision=${4-} expected_size=${5-0}
  local replacement_revision replacement_size
  replacement_revision=$(sha256sum -- "$body_path")
  replacement_revision=${replacement_revision%% *}
  replacement_size=$(stat -c '%s' -- "$body_path")
  operation=$operation \
    target_path=$target_path \
    expected_revision=$expected_revision \
    expected_size=$expected_size \
    replacement_revision=$replacement_revision \
    replacement_size=$replacement_size \
    probe_features=1 \
    "$BASH" "$helper" <"$body_path" >"$root/response"
  grep -a -q 'TERAX_SHELL_FILE_V1' "$root/response"
}

target=$root/existing
printf old >"$target"
chmod 751 "$target"
old_revision=$(printf old | terax_revision)
terax_run write_checked "$target" replacement "$old_revision" 3
grep -a -q written "$root/response"
[ "$(cat "$target")" = replacement ]
[ "$(stat -c '%a' "$target")" = 751 ]

replacement_revision=$(printf replacement | terax_revision)
terax_run write_checked "$target" rejected "$(printf other | terax_revision)" 11
grep -a -q conflict "$root/response"
[ "$(cat "$target")" = replacement ]

missing=$root/missing
: >"$root/default-mode"
terax_run write_missing "$missing" created
grep -a -q written "$root/response"
[ "$(cat "$missing")" = created ]
[ "$(stat -c '%a' "$missing")" = "$(stat -c '%a' "$root/default-mode")" ]

terax_run write_missing "$missing" created
grep -a -q written "$root/response"
[ "$(cat "$missing")" = created ]

terax_run write_missing "$missing" rejected
grep -a -q conflict "$root/response"
[ "$(cat "$missing")" = created ]

directory=$root/existing-directory
mkdir "$directory"
body=rejected
replacement_revision=$(printf '%s' "$body" | terax_revision)
if printf '%s' "$body" | \
  operation=write_missing \
  target_path=$directory \
  expected_revision= \
  expected_size=0 \
  replacement_revision=$replacement_revision \
  replacement_size=${#body} \
  probe_features=1 \
  "$BASH" "$helper" >"$root/response" 2>/dev/null; then
  exit 1
fi
[ -z "$(find "$directory" -mindepth 1 -print -quit)" ]

dangling_target=$root/dangling-target
dangling_link=$root/dangling-link
ln -s "$dangling_target" "$dangling_link"
body=rejected
replacement_revision=$(printf '%s' "$body" | terax_revision)
if printf '%s' "$body" | \
  operation=write_missing \
  target_path=$dangling_link \
  expected_revision= \
  expected_size=0 \
  replacement_revision=$replacement_revision \
  replacement_size=${#body} \
  probe_features=1 \
  "$BASH" "$helper" >"$root/response" 2>/dev/null; then
  exit 1
fi
[ -L "$dangling_link" ]
[ ! -e "$dangling_target" ]

binary=$root/binary
printf '\000raw\377' >"$root/binary-request"
terax_run_file write_missing "$binary" "$root/binary-request"
cmp "$root/binary-request" "$binary"

real_target=$root/real-target
link_target=$root/link-target
printf before >"$real_target"
chmod 640 "$real_target"
ln -s "$real_target" "$link_target"
terax_run write_overwrite "$link_target" after
[ -L "$link_target" ]
[ "$(cat "$real_target")" = after ]
[ "$(stat -c '%a' "$real_target")" = 640 ]

terax_run write_overwrite "$target" overwritten
grep -a -q written "$root/response"
[ "$(cat "$target")" = overwritten ]
[ "$(stat -c '%a' "$target")" = 751 ]

: >"$root/empty-request"
terax_run_file write_overwrite "$target" "$root/empty-request"
[ ! -s "$target" ]
[ "$(stat -c '%a' "$target")" = 751 ]

if find "$root" -maxdepth 1 -name '.*.terax-*.tmp' | grep -q .; then
  exit 1
fi
