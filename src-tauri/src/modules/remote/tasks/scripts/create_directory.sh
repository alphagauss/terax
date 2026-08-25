# Terax SSH 目录创建任务。
#
# 任务在服务器端创建缺失父链，并用单独的最终 mkdir 保留“目标已存在时报错”的契约。

set -eu

if [ "$probe_features" = 1 ]; then
  for tool in mkdir readlink mktemp rm; do
    command -v "$tool" >/dev/null 2>&1 || exit 72
  done
  readlink -f -- /dev/null >/dev/null 2>&1 || exit 72
  probe=$(mktemp -d) || exit 72
  if ! mkdir -p -- "$probe/a/b" 2>/dev/null; then
    rm -rf -- "$probe"
    exit 72
  fi
  rm -rf -- "$probe" || exit 72
fi

case $target_path in
  /*) ;;
  *) exit 64 ;;
esac

parent=${target_path%/*}
name=${target_path##*/}
[ -n "$name" ] && [ "$name" != . ] && [ "$name" != .. ] || exit 64
[ -n "$parent" ] || parent=/

if [ -e "$target_path" ] || [ -L "$target_path" ]; then
  printf 'TERAX_CREATE_DIR_V1\000exists\000'
  exit 0
fi

mkdir -p -- "$parent" || exit 74
parent=$(readlink -f -- "$parent") || exit 74
if [ "$parent" = / ]; then
  target="/$name"
else
  target="$parent/$name"
fi

if [ -e "$target" ] || [ -L "$target" ]; then
  printf 'TERAX_CREATE_DIR_V1\000exists\000'
elif mkdir -- "$target" 2>/dev/null; then
  printf 'TERAX_CREATE_DIR_V1\000created\000%s\000' "$target"
elif [ -e "$target" ] || [ -L "$target" ]; then
  printf 'TERAX_CREATE_DIR_V1\000exists\000'
else
  exit 74
fi
