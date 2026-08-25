# Terax SSH 文件写入任务。
#
# 脚本通过 exec command 接收封闭参数，通过 stdin 接收原始正文。它不落盘自身，
# 只实现条件写入、缺失创建和显式覆盖，并用固定 NUL 分隔帧返回结果。

set -eu

terax_require_tools() {
  local tool
  for tool in mktemp stat readlink dd chmod rm mv; do
    command -v "$tool" >/dev/null 2>&1 || return 72
  done
  if [ "$operation" = write_missing ]; then
    command -v ln >/dev/null 2>&1 || return 72
  fi
}

terax_probe_features() {
  local probe
  probe=$(mktemp -d) || return 72
  : >"$probe/source"
  : >"$probe/target"
  if ! stat -c '%s' -- /dev/null >/dev/null 2>&1 ||
    ! readlink -f -- /dev/null >/dev/null 2>&1 ||
    ! terax_hash_file /dev/null >/dev/null 2>&1 ||
    ! dd if=/dev/null of="$probe/synced" bs=1 count=0 conv=fsync 2>/dev/null ||
    ! mv -T -- "$probe/source" "$probe/target" 2>/dev/null; then
    rm -rf -- "$probe"
    return 72
  fi
  if [ "$operation" = write_missing ] &&
    ! ln -T -- "$probe/target" "$probe/linked" 2>/dev/null; then
    rm -rf -- "$probe"
    return 72
  fi
  rm -rf -- "$probe" || return 72
}

terax_hash_file() {
  local output
  if command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum -- "$1") || return 74
  elif command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256 -- "$1") || return 74
  elif command -v openssl >/dev/null 2>&1; then
    output=$(openssl dgst -sha256 -r "$1") || return 74
  else
    return 72
  fi
  output=${output%% *}
  [ "${#output}" -eq 64 ] || return 73
  printf '%s' "$output"
}

terax_default_mode() {
  local mask value
  mask=$(umask)
  case $mask in
    [0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) ;;
    *) return 64 ;;
  esac
  value=$((0666 & ~(8#$mask)))
  printf '%03o' "$value"
}

terax_canonical_target() {
  local parent name
  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    readlink -f -- "$target_path"
    return
  fi
  parent=${target_path%/*}
  name=${target_path##*/}
  [ -n "$name" ] && [ "$name" != . ] && [ "$name" != .. ] || return 64
  [ -n "$parent" ] || parent=/
  parent=$(readlink -f -- "$parent") || return 74
  [ -d "$parent" ] || return 74
  if [ "$parent" = / ]; then
    printf '/%s' "$name"
  else
    printf '%s/%s' "$parent" "$name"
  fi
}

terax_stage_file() {
  local mode=$1 actual_size actual_revision
  parent=${target%/*}
  name=${target##*/}
  temporary=$(mktemp "$parent/.${name}.terax-XXXXXXXX.tmp") || return 74
  trap 'rm -f -- "$temporary"' EXIT HUP INT TERM
  chmod "$mode" -- "$temporary" || return 74
  dd of="$temporary" bs=262144 conv=fsync 2>/dev/null || return 74
  actual_size=$(stat -c '%s' -- "$temporary") || return 74
  [ "$actual_size" = "$replacement_size" ] || return 73
  actual_revision=$(terax_hash_file "$temporary") || return $?
  [ "$actual_revision" = "$replacement_revision" ] || return 73
}

terax_discard_stage() {
  rm -f -- "$temporary"
  trap - EXIT HUP INT TERM
}

terax_report() {
  local metadata size mtime
  metadata=$(stat -c '%s %Y' -- "$target") || return 74
  size=${metadata%% *}
  mtime=${metadata#* }
  printf 'TERAX_SHELL_FILE_V1\000%s\000%s\000%s' "$1" "$size" "$mtime"
}

terax_finish_existing() {
  local current_revision
  current_revision=$(terax_hash_file "$target") || return $?
  terax_discard_stage
  if [ "$current_revision" = "$replacement_revision" ]; then
    terax_report written
  else
    terax_report conflict
  fi
}

if [ "$probe_features" = 1 ]; then
  terax_require_tools || exit $?
  terax_probe_features || exit $?
fi
if [ "$operation" = write_missing ] && [ -L "$target_path" ] && [ ! -e "$target_path" ]; then
  exit 76
fi
target=$(terax_canonical_target) || exit $?

case $operation in
  write_checked)
    [ -f "$target" ] || exit 74
    mode=$(stat -c '%a' -- "$target") || exit 74
    terax_stage_file "$mode" || exit $?
    current_size=$(stat -c '%s' -- "$target") || exit 74
    current_revision=$(terax_hash_file "$target") || exit $?
    if [ "$current_revision" = "$replacement_revision" ]; then
      terax_discard_stage
      terax_report written
    elif [ "$current_size" != "$expected_size" ] || [ "$current_revision" != "$expected_revision" ]; then
      terax_discard_stage
      terax_report conflict
    else
      mv -f -T -- "$temporary" "$target" || exit 74
      trap - EXIT HUP INT TERM
      terax_report written
    fi
    ;;
  write_missing)
    mode=$(terax_default_mode) || exit $?
    terax_stage_file "$mode" || exit $?
    if [ -e "$target" ] || [ -L "$target" ]; then
      terax_finish_existing
    elif ln -T -- "$temporary" "$target" 2>/dev/null; then
      terax_discard_stage
      terax_report written
    elif [ -e "$target" ] || [ -L "$target" ]; then
      terax_finish_existing
    else
      exit 74
    fi
    ;;
  write_overwrite)
    if [ -e "$target" ] || [ -L "$target" ]; then
      mode=$(stat -c '%a' -- "$target") || exit 74
    else
      mode=$(terax_default_mode) || exit $?
    fi
    terax_stage_file "$mode" || exit $?
    mv -f -T -- "$temporary" "$target" || exit 74
    trap - EXIT HUP INT TERM
    terax_report written
    ;;
  *)
    exit 64
    ;;
esac
