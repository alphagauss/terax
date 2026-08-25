# Terax SSH 后台进程批量状态查询任务。
#
# 日志正文由 raw SFTP offset 读取；本脚本只输出 PID 与运行状态的 NUL 协议。

set -eu

case $operation in
  list)
    printf 'TERAX_BG_LIST_V1\000'
    for process_id in $process_ids; do
      if kill -0 "$process_id" 2>/dev/null; then
        state=running
      else
        state=exited
      fi
      printf '%s\000%s\000' "$process_id" "$state"
    done
    printf 'END\000'
    ;;
  *) exit 64 ;;
esac
