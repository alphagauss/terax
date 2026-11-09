# Terax SSH 统一服务器能力探测。
#
# 脚本只执行固定命令和临时目录内的无害参数探测，用 NUL 协议返回全部结果；任一能力
# 缺失都不会提前终止，调用方可以一次往返得到完整报告。

set -u
LC_ALL=C

printf 'TERAX_CAPABILITIES_V1\000'
terax_emit bash ready ''
terax_simple_probe sh sh sh -c 'exit 0'
terax_simple_probe setsid setsid setsid --wait /bin/sh -c 'exit 0'

terax_simple_probe find find find /dev/null -maxdepth 0 -printf ''
terax_simple_probe find_delete find find -P /dev/null -xdev -depth -type d -empty -delete
terax_simple_probe readlink readlink readlink -f -- /dev/null
terax_simple_probe stat stat terax_check_stat
terax_simple_probe awk awk awk 'BEGIN { exit 0 }'
terax_begin_probe

terax_probe_in_temp mkdir mkdir mkdir -p -- "$probe_dir/a/b"
terax_probe_paste
terax_probe_git
terax_probe_archive
terax_probe_in_temp chmod chmod chmod 00700 -- "$probe_dir"
terax_probe_in_temp dd dd dd if=/dev/null of="$probe_dir/synced" bs=1 count=0 conv=fsync

if [ -n "$probe_dir" ]; then
  : >"$probe_dir/mv-source"
  : >"$probe_dir/mv-target"
fi
terax_probe_in_temp mv mv mv -T -- "$probe_dir/mv-source" "$probe_dir/mv-target"

terax_check_mv_commit() {
  mv -T -n -- "$probe_dir/mv-target" "$probe_dir/mv-pending" &&
    mv -n -t "$probe_dir/a" -- "$probe_dir/mv-pending"
}
terax_probe_in_temp mv_commit mv terax_check_mv_commit
terax_check_touch_time() {
  touch -a -d @0 -- "$probe_dir/time-target" && touch -m -d @0 -- "$probe_dir/time-target"
}
terax_probe_in_temp touch_time touch terax_check_touch_time

if [ -n "$probe_dir" ]; then
  : >"$probe_dir/ln-target"
fi
terax_probe_in_temp ln ln ln -T -- "$probe_dir/ln-target" "$probe_dir/ln-link"

terax_probe_sha256

if ! command -v rg >/dev/null 2>&1; then
  terax_emit rg_content missing ''
  terax_emit rg_files missing ''
else
  rg --json --no-messages --max-filesize 1 --fixed-strings --word-regexp \
    --ignore-case -- TERAX_REMOTE_TASK_OPTION_PROBE /dev/null >/dev/null 2>&1
  rg_status=$?
  if [ "$rg_status" -le 1 ]; then
    terax_emit rg_content ready ''
  else
    terax_emit rg_content unsupported ''
  fi
  rg --files --null --no-messages --max-depth 1 \
    --glob '!TERAX_REMOTE_TASK_OPTION_PROBE' -- /dev/null >/dev/null 2>&1
  rg_status=$?
  if [ "$rg_status" -le 1 ]; then
    terax_emit rg_files ready ''
  else
    terax_emit rg_files unsupported ''
  fi
fi

if ! command -v grep >/dev/null 2>&1; then
  terax_emit grep missing ''
else
  grep -F -i -w -n -H -Z -I -- TERAX_REMOTE_TASK_OPTION_PROBE /dev/null >/dev/null 2>&1
  grep_status=$?
  if [ "$grep_status" -le 1 ]; then
    terax_emit grep ready ''
  else
    terax_emit grep unsupported ''
  fi
fi

printf 'END\000'
