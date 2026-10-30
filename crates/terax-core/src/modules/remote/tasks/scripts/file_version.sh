# Terax SSH 文件版本任务。
#
# 任务在服务器端一次完成物理路径解析、大小检查、前后元数据校验和 SHA-256，避免将
# 多个依赖阶段放大为高延迟网络往返。

set -eu

terax_hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1"
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1"
  else
    return 72
  fi
}

if [ "$probe_features" = 1 ]; then
  for tool in readlink stat; do
    command -v "$tool" >/dev/null 2>&1 || exit 72
  done
  readlink -f -- /dev/null >/dev/null 2>&1 || exit 72
  stat -c '%d:%i:%s:%y:%z' -- /dev/null >/dev/null 2>&1 || exit 72
  terax_hash_file /dev/null >/dev/null 2>&1 || exit 72
fi

if [ ! -e "$target_path" ]; then
  printf 'TERAX_FILE_VERSION_V1\000missing\000'
  exit 0
fi

target=$(readlink -f -- "$target_path") || exit 74
[ -f "$target" ] || exit 74
before_identity=$(stat -c '%d:%i:%s:%y:%z' -- "$target") || exit 74
before_size=$(stat -c '%s' -- "$target") || exit 74
if [ "$before_size" -gt "$max_size" ]; then
  printf 'TERAX_FILE_VERSION_V1\000toolarge\000%s\000' "$before_size"
  exit 0
fi

revision=$(terax_hash_file "$target") || exit 74
revision=${revision%% *}
[ "${#revision}" -eq 64 ] || exit 74

after_identity=$(stat -c '%d:%i:%s:%y:%z' -- "$target") || exit 74
if [ "$before_identity" != "$after_identity" ]; then
  exit 75
fi
after=$(stat -c '%s %Y' -- "$target") || exit 74
after_size=${after%% *}
after_mtime=${after#* }
if [ "$before_size" != "$after_size" ]; then
  exit 75
fi

printf 'TERAX_FILE_VERSION_V1\000version\000%s\000%s\000%s\000' \
  "$revision" "$after_size" "$after_mtime"
