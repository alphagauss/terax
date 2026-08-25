# Terax SSH 后台进程查询任务。
#
# logs 操作将原始日志写入 stdout，将固定状态协议写入 stderr；list 操作只输出 PID 与
# 运行状态的 NUL 协议，避免任意日志正文伪造控制帧。

set -eu

case $operation in
  logs)
    command -v tail >/dev/null 2>&1 || exit 72
    if [ -f "$log_path" ]; then
      tail -c "+$start_offset" -- "$log_path"
    fi
    if kill -0 "$process_id" 2>/dev/null; then
      state=running
    else
      state=exited
    fi
    printf 'TERAX_BG_LOGS_V1\000%s\000' "$state" >&2
    ;;
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
