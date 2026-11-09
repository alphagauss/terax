# SSH 与 WSL 的固定命令探测及私有临时目录。

terax_emit() {
  printf '%s\000%s\000%s\000' "$1" "$2" "$3"
}

terax_simple_probe() (
  id=$1 tool=$2
  shift 2
  if ! command -v "$tool" >/dev/null 2>&1; then
    terax_emit "$id" missing ''
  elif "$@" >/dev/null 2>&1; then
    terax_emit "$id" ready ''
  else
    terax_emit "$id" unsupported ''
  fi
)

terax_probe_in_temp() (
  id=$1 tool=$2
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
)

terax_begin_probe() {
  if ! command -v rm >/dev/null 2>&1; then
    rm_state=missing
  elif rm -rf -- >/dev/null 2>&1; then
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

  if [ -n "$probe_dir" ]; then
    trap 'rm -rf -- "$probe_dir" >/dev/null 2>&1 || true' 0
  fi
}

terax_probe_paste() {
  if [ -n "$probe_dir" ]; then
    : >"$probe_dir/paste-copy-source"
  fi
  terax_probe_in_temp cp_archive cp cp -a -- "$probe_dir/paste-copy-source" "$probe_dir/cp-target"
  terax_probe_in_temp chmod_recursive chmod chmod -R u+rwX -- "$probe_dir/cp-target"
  # 隔离当前目录和 PYTHONPATH，避免项目中的同名模块影响标准库探测。
  terax_simple_probe python3_renameat2 python3 python3 -I -c 'import ctypes; ctypes.CDLL(None).renameat2'
}

terax_probe_git() {
  terax_simple_probe git git git --version
  terax_simple_probe head head head -c 1 /dev/null
  terax_simple_probe cat cat cat -- /dev/null
  terax_simple_probe wc wc wc -c /dev/null
}

terax_check_stat() {
  stat -c '%d:%i:%s:%y:%z' -- /dev/null && stat --printf='%f\0%s\0%Y\0' -- /dev/null
}

terax_check_tar() {
  tar -czf "$probe_dir/probe.tar.gz" -C "$probe_dir" archive-source &&
    tar -xzf "$probe_dir/probe.tar.gz" -C "$probe_dir"
}

terax_check_tar_sync() {
  printf 'archive-source\000' |
    tar -czf "$probe_dir/probe-sync.tar.gz" -C "$probe_dir" --hard-dereference --no-recursion --null -T -
}

terax_check_gzip() {
  gzip -c </dev/null
}

terax_probe_archive() {
  if [ -n "$probe_dir" ]; then
    : >"$probe_dir/archive-source"
  fi
  terax_simple_probe gzip gzip terax_check_gzip
  terax_probe_in_temp tar_gzip tar terax_check_tar
  terax_probe_in_temp tar_sync tar terax_check_tar_sync
}

terax_probe_sha256() {
  # 与实际脚本的选择顺序一致，已安装但不兼容的首选命令不能被后备命令掩盖。
  if command -v sha256sum >/dev/null 2>&1; then
    set -- sha256sum -- /dev/null
  elif command -v shasum >/dev/null 2>&1; then
    set -- shasum -a 256 -- /dev/null
  elif command -v openssl >/dev/null 2>&1; then
    set -- openssl dgst -sha256 -r /dev/null
  else
    terax_emit sha256 missing ''
    return
  fi
  if "$@" >/dev/null 2>&1; then
    terax_emit sha256 ready "$1"
  else
    terax_emit sha256 unsupported ''
  fi
}
