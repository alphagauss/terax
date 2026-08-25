# Terax SSH 文件版本任务。
#
# 任务在服务器端一次完成物理路径解析、大小检查、前后元数据校验和 SHA-256，避免将
# 多个依赖阶段放大为高延迟网络往返。

set -eu

for tool in readlink stat sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || exit 72
done

if [ ! -e "$target_path" ]; then
  printf 'TERAX_FILE_VERSION_V1\000missing\000'
  exit 0
fi

target=$(readlink -f -- "$target_path") || exit 74
[ -f "$target" ] || exit 74
before=$(stat -c '%s %Y' -- "$target") || exit 74
before_size=${before%% *}
before_mtime=${before#* }
if [ "$before_size" -gt "$max_size" ]; then
  printf 'TERAX_FILE_VERSION_V1\000toolarge\000%s\000' "$before_size"
  exit 0
fi

revision=$(sha256sum -- "$target") || exit 74
revision=${revision%% *}
[ "${#revision}" -eq 64 ] || exit 74

after=$(stat -c '%s %Y' -- "$target") || exit 74
after_size=${after%% *}
after_mtime=${after#* }
if [ "$before_size" != "$after_size" ] || [ "$before_mtime" != "$after_mtime" ]; then
  exit 75
fi

printf 'TERAX_FILE_VERSION_V1\000version\000%s\000%s\000%s\000' \
  "$revision" "$after_size" "$after_mtime"
