# 调用方提供生产脚本和独占临时目录；测试只操作该目录，不自行递归删除。
set -e
script=$1
root=$2

# 大批次、特殊文件名和重叠子目录：验证身份、最终内容、权限与命令数量。
bash -c '
  source "$1"
  cd "$2"
  mkdir -p stage/shared target/shared stage/short target/short
  for index in {1..300}; do
    name=$(printf "%04d-%0180d" "$index" 0)
    printf new > "stage/$name"
    printf old > "target/$name"
    printf new > "stage/short/$index"
    printf old > "target/short/$index"
  done
  for name in "space name" "中文" "-option" ".hidden" "[*]" $'"'"'line\nbreak'"'"'; do
    printf new > "stage/shared/$name"
    printf old > "target/shared/$name"
  done
  mkdir -p stage/new-directory target/removed-directory
  printf keep > stage/new-directory/file
  printf remove > target/removed-directory/file
  root_inode=$(stat -c %i target)
  child_inode=$(stat -c %i target/shared)
  chmod 500 stage/shared
  touch -a -d @1000000000 stage/shared
  touch -m -d @1000000001 stage/shared
  terax_move_commands=0
  mv() {
    terax_move_commands=$((terax_move_commands + 1))
    if [ "$1" = -n ]; then
      local bytes=0 argument
      for argument in "$@"; do bytes=$((bytes + ${#argument} + 1)); done
      [ "$bytes" -lt 32768 ] || return 90
      [ "$#" -le 132 ] || return 91
    fi
    command mv "$@"
  }
  trap terax_rollback EXIT
  terax_reconcile replace stage target backup
  terax_apply_directory_metadata
  trap - EXIT
  [ "$(stat -c %i target)" = "$root_inode" ]
  [ "$(stat -c %i target/shared)" = "$child_inode" ]
  [ "$(stat -c "%a %X %Y" target/shared)" = "500 1000000000 1000000001" ]
  [ "$terax_move_commands" -lt 40 ]
  [ "${#terax_undo_from[@]}" -eq 1214 ]
  [ ! -e target/removed-directory ]
  [ "$(cat target/new-directory/file)" = keep ]
  for index in {1..300}; do
    name=$(printf "%04d-%0180d" "$index" 0)
    [ "$(cat "target/$name")" = new ]
    [ "$(cat "backup/$name")" = old ]
    [ "$(cat "target/short/$index")" = new ]
    [ "$(cat "backup/short/$index")" = old ]
  done
  for file in stage/shared/* stage/shared/.[!.]*; do
    [ ! -e "$file" ]
  done
  for file in target/shared/* target/shared/.[!.]*; do
    [ "$(cat "$file")" = new ]
    [ "$(cat "backup/shared/${file##*/}")" = old ]
  done
  chmod 700 target/shared
' -- "$script" "$root"

# 两种合并优先级保留非冲突项，目标优先同时保留异类型冲突。
for mode in merge merge_skip; do
  mkdir "$root/$mode"
  bash -c '
    source "$1"
    cd "$2"
    mode=$3
    mkdir -p stage/shared target/shared stage/type-conflict
    printf new > stage/shared/file
    printf old > target/shared/file
    printf source > stage/source-only
    printf target > target/target-only
    printf original > target/type-conflict
    inode=$(stat -c %i target/shared)
    trap terax_rollback EXIT
    terax_reconcile "$mode" stage target backup
    terax_apply_directory_metadata
    trap - EXIT
    [ "$(stat -c %i target/shared)" = "$inode" ]
    [ "$(cat target/source-only)" = source ]
    [ "$(cat target/target-only)" = target ]
    if [ "$mode" = merge ]; then
      [ "$(cat target/shared/file)" = new ]
      [ -d target/type-conflict ]
    else
      [ "$(cat target/shared/file)" = old ]
      [ "$(cat target/type-conflict)" = original ]
    fi
  ' -- "$script" "$root/$mode" "$mode"
done

# 注入部分成功、no-clobber 静默跳过和并发目录，失败必须登记已移动项再回滚。
for scenario in backup_failure install_failure nested_failure concurrent_file concurrent_directory; do
  directory=$root/$scenario
  mkdir -p "$directory/stage" "$directory/target"
  printf new-a > "$directory/stage/a"
  printf new-b > "$directory/stage/b"
  if [ "$scenario" != concurrent_directory ]; then
    printf old-a > "$directory/target/a"
    printf old-b > "$directory/target/b"
  fi
  if [ "$scenario" = nested_failure ]; then
    mkdir "$directory/stage/shared" "$directory/target/shared"
    printf new-child > "$directory/stage/shared/file"
    printf old-child > "$directory/target/shared/file"
  fi
  inode=$(stat -c %i "$directory/target")
  chmod 500 "$directory/target"
  touch -a -d @1000000000 "$directory/target"
  touch -m -d @1000000001 "$directory/target"
  status=0
  bash -c '
    source "$1"
    cd "$2"
    scenario=$3
    terax_move_commands=0
    mv() {
      terax_move_commands=$((terax_move_commands + 1))
      if [ "$1" = -n ]; then
        local destination=$3
        if { [ "$scenario" = backup_failure ] && [ "$destination" = backup ]; } ||
           { [ "$scenario" = nested_failure ] && [ "$destination" = backup/shared ]; } ||
           { [ "$scenario" = install_failure ] && [ "$destination" = target ]; }; then
          shift 4
          command mv -n -t "$destination" -- "$1"
          return 17
        fi
        if [ "$destination" = target ]; then
          if [ "$scenario" = concurrent_file ]; then printf concurrent > target/b; fi
          if [ "$scenario" = concurrent_directory ]; then mkdir target/b; fi
        fi
      fi
      command mv "$@"
    }
    terax_backup_roots+=(backup)
    trap terax_rollback EXIT
    terax_reconcile replace stage target backup
    terax_apply_directory_metadata
    trap - EXIT
  ' -- "$script" "$directory" "$scenario" || status=$?
  [ "$status" -ne 0 ]
  [ "$(stat -c %i "$directory/target")" = "$inode" ]
  [ "$(stat -c '%a %X %Y' "$directory/target")" = '500 1000000000 1000000001' ]
  [ "$(cat "$directory/stage/a")" = new-a ]
  [ "$(cat "$directory/stage/b")" = new-b ]
  if [ "$scenario" = nested_failure ]; then
    [ "$(cat "$directory/stage/shared/file")" = new-child ]
    [ "$(cat "$directory/target/shared/file")" = old-child ]
  fi
  case "$scenario" in
    concurrent_file)
      [ "$status" -eq 125 ]
      [ "$(cat "$directory/target/a")" = old-a ]
      [ "$(cat "$directory/target/b")" = concurrent ]
      [ "$(cat "$directory/backup/b")" = old-b ]
      ;;
    concurrent_directory)
      [ ! -e "$directory/target/a" ]
      [ -d "$directory/target/b" ]
      [ -z "$(ls -A "$directory/target/b")" ]
      ;;
    *)
      [ "$(cat "$directory/target/a")" = old-a ]
      [ "$(cat "$directory/target/b")" = old-b ]
      ;;
  esac
done

# 属性恢复批次保留差异；权限最后恢复，失败时仍可重新打开目录并还原内容和属性。
for scenario in success time_failure permission_failure; do
  directory=$root/metadata_$scenario
  mkdir "$directory"
  status=0
  bash -c '
    source "$1"
    cd "$2"
    scenario=$3
    mkdir stage target
    paths=()
    for index in {1..140}; do
      name=$(printf "d%03d" "$index")
      mkdir "stage/$name" "target/$name"
      paths+=("$name")
      if [ "$index" -le 70 ]; then mode=500; timestamp=1000000000; else mode=700; timestamp=1000000010; fi
      chmod "$mode" "stage/$name"
      touch -a -d @1000000000 "stage/$name"
      touch -m -d "@$((timestamp + 1))" "stage/$name"
      touch -a -d @900000000 "target/$name"
      touch -m -d @900000001 "target/$name"
    done
    mkdir -p stage/locked/child target/locked/child
    printf new > stage/locked/child/file
    printf old > target/locked/child/file
    chmod 500 stage/locked/child
    chmod 000 stage/locked
    touch -a -d @900000000 target/locked/child target/locked target
    touch -m -d @900000001 target/locked/child target/locked target
    paths+=(locked/child locked "")
    command stat -c "%i %a %X %Y" -- "${paths[@]/#/target/}" > original-metadata
    metadata_phase=0
    failed_once=0
    permission_started=0
    metadata_commands=0
    touch() {
      if [ "$metadata_phase" = 1 ] && [ "$failed_once" = 0 ]; then
        [ "$permission_started" = 0 ] || return 90
        metadata_commands=$((metadata_commands + 1))
        [ "$#" -le 132 ] || return 91
        if [ "$scenario" = time_failure ] && [ "$1" = -m ]; then
          failed_once=1
          command touch "${@:1:5}"
          return 17
        fi
      fi
      command touch "$@"
    }
    chmod() {
      if [ "$metadata_phase" = 1 ] && [ "$failed_once" = 0 ]; then
        permission_started=1
        metadata_commands=$((metadata_commands + 1))
        [ "$#" -le 130 ] || return 92
        printf "%s\n" "${@:3}" >> permission-order
        if [ "$scenario" = permission_failure ] && [ "$1" = 00000 ]; then
          failed_once=1
          command chmod "${@:1:3}"
          return 18
        fi
      fi
      command chmod "$@"
    }
    trap terax_rollback EXIT
    terax_reconcile replace stage target backup
    metadata_phase=1
    terax_apply_directory_metadata
    trap - EXIT
    [ "$metadata_commands" -lt 30 ]
    [ "$(command stat -c %a target/locked)" = 0 ]
    command chmod 700 target/locked
    command stat -c "%i" -- "${paths[@]/#/target/}" > final-inodes
    cut -d " " -f 1 original-metadata > original-inodes
    cmp original-inodes final-inodes
    [ "$(command stat -c %a target/locked/child)" = 500 ]
    [ "$(cat target/locked/child/file)" = new ]
    for index in {1..140}; do
      name=$(printf "d%03d" "$index")
      if [ "$index" -le 70 ]; then mode=500; timestamp=1000000000; else mode=700; timestamp=1000000010; fi
      [ "$(command stat -c "%a %X %Y" "target/$name")" = "$mode 1000000000 $((timestamp + 1))" ]
    done
    child_line=$(grep -nx target/locked/child permission-order)
    parent_line=$(grep -nx target/locked permission-order)
    [ "${child_line%%:*}" -lt "${parent_line%%:*}" ]
  ' -- "$script" "$directory" "$scenario" || status=$?
  if [ "$scenario" = success ]; then
    [ "$status" -eq 0 ]
  else
    [ "$status" -ne 0 ] && [ "$status" -ne 125 ]
    [ "$(cat "$directory/target/locked/child/file")" = old ]
    [ "$(cat "$directory/stage/locked/child/file")" = new ]
    (
      cd "$directory"
      paths=()
      for index in {1..140}; do paths+=("$(printf "d%03d" "$index")"); done
      paths+=(locked/child locked "")
      stat -c "%i %a %X %Y" -- "${paths[@]/#/target/}" > restored-metadata
      cmp original-metadata restored-metadata
    )
  fi
done
# 父目录队列跨越新目录移动和子目录递归；任一层失败都按实际移动顺序回滚。
for scenario in success parent_failure child_failure concurrent_parent; do
  directory=$root/queued_$scenario
  mkdir -p "$directory/stage/b" "$directory/stage/m" "$directory/target/m"
  for name in a c z m/file; do
    printf new > "$directory/stage/$name"
    if [ "$scenario" != concurrent_parent ] || [ "$name" != c ]; then
      printf old > "$directory/target/$name"
    fi
  done
  inode=$(stat -c '%i' "$directory/target" "$directory/target/m")
  status=0
  bash -c '
    source "$1"
    cd "$2"
    scenario=$3
    terax_move_commands=0
    mv() {
      terax_move_commands=$((terax_move_commands + 1))
      if [ "$1" = -n ]; then
        local destination=$3
        if [ "$scenario" = concurrent_parent ] && [ "$destination" = backup/m ]; then
          printf concurrent > target/c
        fi
        if { [ "$scenario" = parent_failure ] && [ "$destination" = target ]; } ||
           { [ "$scenario" = child_failure ] && [ "$destination" = backup/m ]; }; then
          shift 4
          command mv -n -t "$destination" -- "$1"
          return 17
        fi
      fi
      command mv "$@"
    }
    trap terax_rollback EXIT
    terax_reconcile replace stage target backup
    terax_apply_directory_metadata
    trap - EXIT
    [ "$terax_move_commands" -eq 5 ]
  ' -- "$script" "$directory" "$scenario" || status=$?
  [ "$(stat -c '%i' "$directory/target" "$directory/target/m")" = "$inode" ]
  if [ "$scenario" = success ]; then
    [ "$status" -eq 0 ]
    [ -d "$directory/target/b" ]
    for name in a c z m/file; do [ "$(cat "$directory/target/$name")" = new ]; done
  else
    [ "$status" -ne 0 ] && [ "$status" -ne 125 ]
    [ ! -e "$directory/target/b" ] && [ -d "$directory/stage/b" ]
    for name in a c z m/file; do
      [ "$(cat "$directory/stage/$name")" = new ]
      if [ "$scenario" = concurrent_parent ] && [ "$name" = c ]; then
        [ "$(cat "$directory/target/$name")" = concurrent ]
      else
        [ "$(cat "$directory/target/$name")" = old ]
      fi
    done
  fi
done
# 精确恢复 setgid 位，包括成功时清除旧位，以及提交后失败时恢复原始位。
for scenario in success rollback; do
  directory=$root/special_modes_$scenario
  mkdir -p "$directory/stage/a" "$directory/stage/b" "$directory/target/a" "$directory/target/b"
  chmod 00755 "$directory/stage/a" "$directory/target/b"
  chmod 02755 "$directory/stage/b" "$directory/target/a"
  inode=$(stat -c '%i' "$directory/target/a" "$directory/target/b")
  status=0
  bash -c '
    source "$1"
    cd "$2"
    trap terax_rollback EXIT
    terax_reconcile replace stage target backup
    terax_apply_directory_metadata
    [ "$3" = success ]
    trap - EXIT
  ' -- "$script" "$directory" "$scenario" || status=$?
  [ "$(stat -c '%i' "$directory/target/a" "$directory/target/b")" = "$inode" ]
  if [ "$scenario" = success ]; then
    [ "$status" -eq 0 ]
    [ "$(stat -c %a "$directory/target/a")" = 755 ]
    [ "$(stat -c %a "$directory/target/b")" = 2755 ]
  else
    [ "$status" -eq 1 ]
    [ "$(stat -c %a "$directory/target/a")" = 2755 ]
    [ "$(stat -c %a "$directory/target/b")" = 755 ]
  fi
done
printf 'batch reconciliation checks passed\n'
