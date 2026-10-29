#!/usr/bin/env bash
# 验证检查协议、固定长度追加、路径转义、截断与摘要完整性；不连接真实服务器。
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
helper="$script_dir/file_sync.sh"
temporary_root=$(cd -- "${TMPDIR:-/tmp}" && pwd -P)
work=$(mktemp -d "$temporary_root/terax-file-sync-XXXXXXXX")
case "$work" in "$temporary_root"/terax-file-sync-*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$work"' EXIT
export target_path="$work/file ' with spaces.log" max_size=52428800 block_size=262144 previous_size=18446744073709551615 previous_mtime=0 verify=1
"$BASH" "$helper" >"$work/missing"
mapfile -d '' -t fields <"$work/missing"
[ "${fields[1]}" = missing ]
printf 'payload\r\n' >"$target_path"
"$BASH" "$helper" >"$work/first"
mapfile -d '' -t fields <"$work/first"
[ "${fields[1]}" = changed ]
[ "${fields[2]}" = 9 ]
expected=$(sha256sum "$target_path"); expected=${expected%% *}
[ "${fields[4]}" = "$expected" ]
[ "${fields[5]}" = "$expected" ]
export previous_size=${fields[2]} previous_mtime=${fields[3]} verify=0
"$BASH" "$helper" >"$work/unchanged"
mapfile -d '' -t fields <"$work/unchanged"
[ "${fields[1]}" = unchanged ]
export verify=1
printf 'rewritten' >"$target_path"
touch -d "@$previous_mtime" "$target_path"
"$BASH" "$helper" >"$work/rewrite"
mapfile -d '' -t fields <"$work/rewrite"
[ "${fields[1]}" = changed ]
[ "${fields[4]}" != "$expected" ]
: >"$target_path"
"$BASH" "$helper" >"$work/empty"
mapfile -d '' -t fields <"$work/empty"
[ "${fields[2]}" = 0 ]
[ "${#fields[@]}" = 5 ]
printf 'too large' >"$target_path"
max_size=2 "$BASH" "$helper" >"$work/large"
mapfile -d '' -t fields <"$work/large"
[ "${fields[1]}" = toolarge ]
# 在摘要计算期间追加，响应必须仍然对应本轮捕获的九字节前缀。
printf 'original!' >"$target_path"
mkdir "$work/bin"
hash_command=$(command -v sha256sum)
cat >"$work/bin/sha256sum" <<EOF
#!/usr/bin/env bash
if [ ! -f "$work/appended" ]; then
  printf appended >>"\$target_path"
  : >"$work/appended"
fi
exec "$hash_command" "\$@"
EOF
chmod +x "$work/bin/sha256sum"
PATH="$work/bin:$PATH" "$BASH" "$helper" >"$work/append"
mapfile -d '' -t fields <"$work/append"
[ "${fields[2]}" = 9 ]
expected=$(printf 'original!' | sha256sum); expected=${expected%% *}
[ "${fields[4]}" = "$expected" ]
[ "$(stat -c '%s' "$target_path")" -gt 9 ]
printf 'file_sync script tests passed\n'
