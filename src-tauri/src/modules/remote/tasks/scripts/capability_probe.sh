# Terax SSH 统一服务器能力探测。
#
# 脚本只执行固定命令和临时目录内的无害参数探测，用 NUL 协议返回全部结果；任一能力
# 缺失都不会提前终止，调用方可以一次往返得到完整报告。

set -u
LC_ALL=C

terax_emit() {
  printf '%s\000%s\000%s\000' "$1" "$2" "$3"
}

terax_simple_probe() {
  local id=$1 tool=$2
  shift 2
  if ! command -v "$tool" >/dev/null 2>&1; then
    terax_emit "$id" missing ''
  elif "$@" >/dev/null 2>&1; then
    terax_emit "$id" ready ''
  else
    terax_emit "$id" unsupported ''
  fi
}

printf 'TERAX_CAPABILITIES_V1\000'
terax_emit bash ready ''
terax_simple_probe setsid setsid setsid --wait /bin/sh -c 'exit 0'

terax_simple_probe find find find /dev/null -maxdepth 0 -printf ''
terax_simple_probe readlink readlink readlink -f -- /dev/null
terax_simple_probe stat stat stat -c '%d:%i:%s:%y:%z' -- /dev/null
terax_simple_probe awk awk awk 'BEGIN { exit 0 }'
if ! command -v rm >/dev/null 2>&1; then
  rm_state=missing
elif rm -rf -- /tmp/terax-capability-probe-does-not-exist >/dev/null 2>&1; then
  rm_state=ready
else
  rm_state=unsupported
fi
terax_emit rm "$rm_state" ''

probe_dir=
if ! command -v mktemp >/dev/null 2>&1; then
  terax_emit mktemp missing ''
elif [ "$rm_state" != ready ]; then
  terax_emit mktemp unsupported ''
else
  probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/terax-capability-XXXXXXXX" 2>/dev/null) || probe_dir=
  if [ -n "$probe_dir" ]; then
    terax_emit mktemp ready ''
  else
    terax_emit mktemp unsupported ''
  fi
fi

terax_probe_in_temp() {
  local id=$1 tool=$2
  shift 2
  if ! command -v "$tool" >/dev/null 2>&1; then
    terax_emit "$id" missing ''
  elif [ -z "$probe_dir" ]; then
    terax_emit "$id" unsupported ''
  elif "$@" >/dev/null 2>&1; then
    terax_emit "$id" ready ''
  else
    terax_emit "$id" unsupported ''
  fi
}

terax_probe_in_temp mkdir mkdir mkdir -p -- "$probe_dir/a/b"
terax_probe_in_temp chmod chmod chmod 700 -- "$probe_dir"
terax_probe_in_temp dd dd dd if=/dev/null of="$probe_dir/synced" bs=1 count=0 conv=fsync

if [ -n "$probe_dir" ]; then
  : >"$probe_dir/mv-source"
  : >"$probe_dir/mv-target"
fi
terax_probe_in_temp mv mv mv -T -- "$probe_dir/mv-source" "$probe_dir/mv-target"

if [ -n "$probe_dir" ]; then
  : >"$probe_dir/ln-target"
fi
terax_probe_in_temp ln ln ln -T -- "$probe_dir/ln-target" "$probe_dir/ln-link"

if command -v sha256sum >/dev/null 2>&1 && sha256sum -- /dev/null >/dev/null 2>&1; then
  terax_emit sha256 ready sha256sum
elif command -v shasum >/dev/null 2>&1 && shasum -a 256 -- /dev/null >/dev/null 2>&1; then
  terax_emit sha256 ready shasum
elif command -v openssl >/dev/null 2>&1 && openssl dgst -sha256 -r /dev/null >/dev/null 2>&1; then
  terax_emit sha256 ready openssl
else
  terax_emit sha256 missing ''
fi

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

if [ -n "$probe_dir" ]; then
  rm -rf -- "$probe_dir" >/dev/null 2>&1 || true
fi
printf 'END\000'
