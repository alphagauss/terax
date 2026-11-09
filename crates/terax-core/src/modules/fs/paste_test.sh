#!/usr/bin/env bash
# 用真实目录验证远端脚本的无覆盖提交、失败清理和链接边界。
set -euo pipefail
script=$1
work=$(mktemp -d)
trap 'chmod -R u+rwX -- "$work"; rm -rf -- "$work"' EXIT
printf 'raise RuntimeError("project ctypes must not be imported")\n' >"$work/ctypes.py"
cd -- "$work"
mkdir -- "$work/source" "$work/target"
printf original >"$work/source/a'b.txt"
printf existing >"$work/target/a'b.txt"

paste_file() {
  bash "$script" "$work/source/a'b.txt" "$work/target" copy "a'b" .txt 1 "a'b.txt" 1 100
}
paste_file >"$work/first" &
first_pid=$!
paste_file >"$work/second" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
[ "$(cat "$work/target/a'b.txt")" = existing ]
[ "$(cat "$work/target/a'b copy.txt")" = original ]
[ "$(cat "$work/target/a'b copy 2.txt")" = original ]
[ "$(find "$work/target" -mindepth 1 -maxdepth 1 | wc -l)" -eq 3 ]

mkdir -- "$work/source/readonly"
printf keep >"$work/source/readonly/file"
ln -s "$work/target" "$work/source/readonly/link"
chmod -R a-w -- "$work/source/readonly"
# 名称尝试额度为零，在复制后稳定触发失败，从而验证暂存树清理。
result=$(bash "$script" "$work/source/readonly" "$work/target" copy readonly '' 1 readonly 1 0)
[ "$result" = names-exhausted ]
[ "$(find "$work/target" -name '.terax-paste-*' | wc -l)" -eq 0 ]
[ "$(cat "$work/source/readonly/file")" = keep ]
[ "$(cat "$work/target/a'b.txt")" = existing ]

result=$(bash "$script" "$work/source" "$work/source/readonly" cut source '' 1 source 1 100)
[ "$result" = descendant ]
result=$(bash "$script" "$work/source/a'b.txt" "$work/target" cut "a'b" .txt 1 "a'b.txt" 1 100)
[ "$result" = $'ok\na\x27b copy 3.txt' ]
[ ! -e "$work/source/a'b.txt" ]
[ "$(cat "$work/target/a'b copy 3.txt")" = original ]
