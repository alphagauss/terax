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

terax_record_directory_metadata() {
  local target=$1
  local final_reference=$2
  local original_mode original_atime original_mtime
  local final_mode final_atime final_mtime
  original_mode=$(stat -c %a -- "$target") || return $?
  original_atime=$(stat -c %X -- "$target") || return $?
  original_mtime=$(stat -c %Y -- "$target") || return $?
  if [ -n "$final_reference" ]; then
    final_mode=$(stat -c %a -- "$final_reference") || return $?
    final_atime=$(stat -c %X -- "$final_reference") || return $?
    final_mtime=$(stat -c %Y -- "$final_reference") || return $?
  else
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

terax_restore_metadata() {
  local target=$1
  local mode=$2
  local atime=$3
  local mtime=$4
  chmod u+rwx -- "$target" || return $?
  touch -a -d "@$atime" -- "$target" || return $?
  touch -m -d "@$mtime" -- "$target" || return $?
  chmod "$mode" -- "$target"
}

terax_reconcile() {
  local mode=$1
  local source=$2
  local target=$3
  local backup=$4
  local target_item source_item backup_item name
  [ -d "$source" ] && [ ! -L "$source" ] || return 1
  [ -d "$target" ] && [ ! -L "$target" ] || return 1
  mkdir -- "$backup"
  if [ "$mode" = merge_skip ]; then
    terax_record_directory_metadata "$target" ""
  else
    terax_record_directory_metadata "$target" "$source"
  fi
  chmod u+rwx -- "$source" "$target" "$backup"

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
    if terax_exists "$target_item"; then
      [ "$mode" = merge_skip ] && continue
      terax_record_move "$target_item" "$backup_item"
    fi
    terax_record_move "$source_item" "$target_item"
  done
}

terax_apply_directory_metadata() {
  local index=$((${#terax_metadata_target[@]} - 1))
  while [ "$index" -ge 0 ]; do
    terax_restore_metadata "${terax_metadata_target[$index]}" "${terax_final_mode[$index]}" "${terax_final_atime[$index]}" "${terax_final_mtime[$index]}"
    index=$((index - 1))
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
