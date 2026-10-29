# 合并元数据快路径与固定长度分块摘要检查。正文仍由 SFTP 读取，不创建远端缓存。
set -euo pipefail
LC_ALL=C
for tool in stat readlink dd; do
  command -v "$tool" >/dev/null 2>&1 || exit 72
done
terax_hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r
  else return 72
  fi
}
dd if=/dev/null iflag=skip_bytes,count_bytes count=0 >/dev/null 2>&1 || exit 72
stat -c '%d:%i' -- /dev/null >/dev/null 2>&1 || exit 72
printf 'TERAX_FILE_SYNC_V1\000'
if [ ! -e "$target_path" ]; then printf 'missing\000'; exit 0; fi
target=$(readlink -f -- "$target_path") || exit 74
[ -f "$target" ] || exit 74
exec 9<"$target" || exit 74
source_path=/proc/self/fd/9
identity=$(stat -Lc '%d:%i' -- "$source_path") || exit 74
metadata=$(stat -Lc '%s %Y' -- "$source_path") || exit 74
size=${metadata%% *}
mtime=${metadata#* }
if [ "$size" -gt "$max_size" ]; then
  printf 'toolarge\000%s\000%s\000' "$size" "$mtime"; exit 0
fi
if [ "$verify" = 0 ] && [ "$size" = "$previous_size" ] && [ "$mtime" = "$previous_mtime" ]; then
  printf 'unchanged\000%s\000%s\000' "$size" "$mtime"; exit 0
fi
hashes=()
for ((offset=0; offset<size; offset+=block_size)); do
  length=$((size-offset))
  if [ "$length" -gt "$block_size" ]; then length=$block_size; fi
  digest=$(dd if="$source_path" bs="$block_size" iflag=skip_bytes,count_bytes skip="$offset" count="$length" status=none | terax_hash) || exit 72
  hashes+=("${digest%% *}")
done
revision=$(dd if="$source_path" bs="$block_size" iflag=count_bytes count="$size" status=none | terax_hash) || exit 72
revision=${revision%% *}
# 并发追加留到下一轮；截断和路径替换不能产生一个已确认的检查点。
[ "$(stat -Lc '%d:%i' -- "$target")" = "$identity" ] || exit 75
[ "$(stat -Lc '%s' -- "$source_path")" -ge "$size" ] || exit 75
printf 'changed\000%s\000%s\000%s\000' "$size" "$mtime" "$revision"
# Bash 4.3 及更早版本在 nounset 下不能展开空数组。
if [ "$size" -gt 0 ]; then
  for digest in "${hashes[@]}"; do printf '%s\000' "$digest"; done
fi
