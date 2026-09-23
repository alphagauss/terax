# SSH 和 WSL Archive 在目标侧原位协调目录的闭合脚本。
# 调用方追加经过 shell_quote 的根路径和受限 cleanup 命令。

set -e
terax_undo_from=()
terax_undo_to=()
terax_backup_roots=()
terax_metadata_target=()
terax_original_mode=()
terax_original_atime=()
terax_original_mtime=()
terax_final_mode=()
terax_final_atime=()
terax_final_mtime=()

terax_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

terax_move_no_replace() {
  local source=$1
  local target=$2
  ! terax_exists "$target" || return 1
  mv -T -n -- "$source" "$target" || return $?
  ! terax_exists "$source" && terax_exists "$target"
}

terax_record_move() {
  local source=$1
  local target=$2
  terax_move_no_replace "$source" "$target"
  terax_undo_from+=("$source")
  terax_undo_to+=("$target")
}

# 仅批量处理普通文件；目录仍走精确目标移动，重叠目录始终原位递归。
# mv 可能部分成功或因 no-clobber 跳过条目，必须先登记所有实际移动再报告失败。
terax_record_file_batch() {
  local directory=$1
  shift
  [ "$#" -gt 0 ] || return 0
  local source target status=0
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  for source in "$@"; do
    target=$directory/${source##*/}
    [ -f "$source" ] && [ ! -L "$source" ] || return 1
    ! terax_exists "$target" || return 1
  done
  mv -n -t "$directory" -- "$@" || status=$?
  for source in "$@"; do
    target=$directory/${source##*/}
    if ! terax_exists "$source" && terax_exists "$target"; then
      terax_undo_from+=("$source")
      terax_undo_to+=("$target")
    else
      status=1
    fi
  done
  return "$status"
}

# 使用当前 terax_reconcile 栈帧的局部批次；递归使用独立队列，父目录文件留在原位等待提交。
terax_flush_file_batch() {
  terax_record_file_batch "$backup" "${batch_old[@]}" || return $?
  terax_record_file_batch "$target" "${batch_new[@]}" || return $?
  batch_old=()
  batch_new=()
  batch_bytes=0
}

terax_record_directory_metadata() {
  local target=$1
  local final_reference=$2
  local original_mode original_atime original_mtime
  local final_mode final_atime final_mtime
  local metadata
  metadata=$(stat -c '%a %X %Y' -- "$target" "$final_reference") || return $?
  {
    read -r original_mode original_atime original_mtime
    read -r final_mode final_atime final_mtime
  } <<< "$metadata"
  # writable_directories 属于当前协调栈帧，只修改缺少拥有者访问权限的目录。
  if (( (8#$original_mode & 0700) != 0700 )); then
    writable_directories+=("$target")
  fi
  if (( (8#$final_mode & 0700) != 0700 )); then
    writable_directories+=("$final_reference")
  fi
  if [ "$3" = merge_skip ]; then
    final_mode=$original_mode
    final_atime=$original_atime
    final_mtime=$original_mtime
  fi
  terax_metadata_target+=("$target")
  terax_original_mode+=("$original_mode")
  terax_original_atime+=("$original_atime")
  terax_original_mtime+=("$original_mtime")
  terax_final_mode+=("$final_mode")
  terax_final_atime+=("$final_atime")
  terax_final_mtime+=("$final_mtime")
}

# 回滚独立保留逐目录权限修复，覆盖最终权限批次只成功了一部分的情况。
terax_restore_metadata() {
  local target=$1
  local mode=$2
  local atime=$3
  local mtime=$4
  chmod u+rwx -- "$target" || return $?
  touch -a -d "@$atime" -- "$target" || return $?
  touch -m -d "@$mtime" -- "$target" || return $?
  # 五位八进制要求 GNU chmod 精确恢复特殊位，避免隐式保留旧目录的 setgid/setuid。
  printf -v mode '%05o' "$((8#$mode))"
  chmod "$mode" -- "$target"
}

terax_reconcile() {
  local mode=$1
  local source=$2
  local target=$3
  local backup=$4
  local target_item source_item backup_item name
  # 按字节计算参数预算，不受文件名字符集影响；批次同时限制条目数和参数长度。
  local LC_ALL=C
  local batch_old=() batch_new=() batch_bytes=0 entry_bytes
  [ -d "$source" ] && [ ! -L "$source" ] || return 1
  [ -d "$target" ] && [ ! -L "$target" ] || return 1
  mkdir -m 700 -- "$backup"
  local writable_directories=()
  terax_record_directory_metadata "$target" "$source" "$mode"
  if [ "${#writable_directories[@]}" -gt 0 ]; then
    chmod u+rwx -- "${writable_directories[@]}"
  fi

  if [ "$mode" = replace ]; then
    for target_item in "$target"/* "$target"/.[!.]* "$target"/..?*; do
      terax_exists "$target_item" || continue
      name=${target_item##*/}
      source_item=$source/$name
      terax_exists "$source_item" && continue
      terax_record_move "$target_item" "$backup/$name"
    done
  fi

  for source_item in "$source"/* "$source"/.[!.]* "$source"/..?*; do
    terax_exists "$source_item" || continue
    name=${source_item##*/}
    target_item=$target/$name
    backup_item=$backup/$name
    if [ -d "$source_item" ] && [ ! -L "$source_item" ] && [ -d "$target_item" ] && [ ! -L "$target_item" ]; then
      terax_reconcile "$mode" "$source_item" "$target_item" "$backup_item"
      continue
    fi
    if [ -f "$source_item" ] && [ ! -L "$source_item" ] && { ! terax_exists "$target_item" || { [ -f "$target_item" ] && [ ! -L "$target_item" ]; }; }; then
      if terax_exists "$target_item" && [ "$mode" = merge_skip ]; then
        continue
      fi
      entry_bytes=$((${#source_item} + ${#target_item} + ${#backup_item} + 3))
      if [ "${#batch_new[@]}" -ge 128 ] || [ "$((batch_bytes + entry_bytes))" -gt 32768 ]; then
        terax_flush_file_batch
      fi
      if terax_exists "$target_item"; then
        batch_old+=("$target_item")
      fi
      batch_new+=("$source_item")
      batch_bytes=$((batch_bytes + entry_bytes))
      continue
    fi
    if terax_exists "$target_item"; then
      [ "$mode" = merge_skip ] && continue
      terax_record_move "$target_item" "$backup_item"
    fi
    terax_record_move "$source_item" "$target_item"
  done
  terax_flush_file_batch
}

# 时间恢复时全部目标仍可访问；最终权限批次保持子目录先于父目录的原始顺序。
terax_apply_metadata_batch() {
  local property=$1 value=$2
  shift 2
  [ "$#" -gt 0 ] || return 0
  case "$property" in
    atime) touch -a -d "@$value" -- "$@" ;;
    mtime) touch -m -d "@$value" -- "$@" ;;
    mode)
      printf -v value '%05o' "$((8#$value))"
      chmod "$value" -- "$@"
      ;;
  esac
}

terax_apply_directory_metadata() {
  local LC_ALL=C
  local property index value path batch_value batch_bytes
  local batch=()
  for property in atime mtime mode; do
    batch=()
    batch_value=
    batch_bytes=128
    index=$((${#terax_metadata_target[@]} - 1))
    while [ "$index" -ge 0 ]; do
      path=${terax_metadata_target[$index]}
      case "$property" in
        atime) value=${terax_final_atime[$index]} ;;
        mtime) value=${terax_final_mtime[$index]} ;;
        mode) value=${terax_final_mode[$index]} ;;
      esac
      if [ "$value" != "$batch_value" ] || [ "${#batch[@]}" -ge 128 ] || [ "$((batch_bytes + ${#path} + 1))" -gt 32768 ]; then
        terax_apply_metadata_batch "$property" "$batch_value" "${batch[@]}"
        batch=()
        batch_bytes=128
      fi
      batch+=("$path")
      batch_value=$value
      batch_bytes=$((batch_bytes + ${#path} + 1))
      index=$((index - 1))
    done
    terax_apply_metadata_batch "$property" "$batch_value" "${batch[@]}"
  done
}

terax_rollback() {
  local status=$?
  local rollback_failed=0
  local target source backup index
  trap - EXIT
  set +e
  for target in "${terax_metadata_target[@]}"; do
    chmod u+rwx -- "$target" || rollback_failed=1
  done
  index=$((${#terax_undo_from[@]} - 1))
  while [ "$index" -ge 0 ]; do
    source=${terax_undo_from[$index]}
    target=${terax_undo_to[$index]}
    terax_move_no_replace "$target" "$source" || rollback_failed=1
    index=$((index - 1))
  done
  index=$((${#terax_metadata_target[@]} - 1))
  while [ "$index" -ge 0 ]; do
    terax_restore_metadata "${terax_metadata_target[$index]}" "${terax_original_mode[$index]}" "${terax_original_atime[$index]}" "${terax_original_mtime[$index]}" || rollback_failed=1
    index=$((index - 1))
  done
  if [ "$rollback_failed" != 0 ]; then
    echo 'transfer rollback failed; recovery data remains in task backup' >&2
    exit 125
  fi
  # 回滚完成后只删除同设备上的空目录，异常残留继续作为 recovery 数据保留。
  for backup in "${terax_backup_roots[@]}"; do
    if [ -d "$backup" ] && [ ! -L "$backup" ]; then
      parent=${backup%/*}
      [ -n "$parent" ] || parent=/
      backup_device=$(stat -c %d -- "$backup")
      parent_device=$(stat -c %d -- "$parent")
      if [ "$backup_device" = "$parent_device" ]; then
        find -P "$backup" -xdev -depth -type d -empty -delete
      fi
    fi
  done
  exit "$status"
}
