# Terax Bash 目录属性统计 helper。
#
# 目标路径由调用方放入 target_path，脚本只执行只读遍历并输出固定数字协议。

command -v find >/dev/null 2>&1 || exit 72
command -v awk >/dev/null 2>&1 || exit 72
find /dev/null -maxdepth 0 -printf '' >/dev/null 2>&1 || exit 72
[ -d "$target_path" ] && [ ! -L "$target_path" ] || exit 73

set -o pipefail
LC_ALL=C find -P "$target_path" -mindepth 1 -printf '%y\t%s\t%b\n' |
  LC_ALL=C awk -F '\t' '
    $1 == "d" { directories += 1; next }
    $1 == "l" { links += 1; next }
    { files += 1; logical += $2; allocated += $3 * 512 }
    END {
      printf "TERAX_PROPERTIES_SCAN_V1 %.0f %.0f %.0f %.0f %.0f\n", files, directories, links, logical, allocated
    }
  '
exit "${PIPESTATUS[0]}"
