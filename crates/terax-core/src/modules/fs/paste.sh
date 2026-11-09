# 在远端及 WSL 的目标文件系统内暂存并以无覆盖方式提交文件树粘贴。
set -eu
source=$1
destination=$2
mode=$3
stem=$4
extension=$5
first=$6
limit=$9

exists() { [ -e "$1" ] || [ -L "$1" ]; }

# mv 的无覆盖模式可在某些文件系统上退回先检查再移动。直接调用内核，
# 不支持原子重命名的挂载上保留源和已有目标，并把失败返回给调用方。
publish() {
  python3 -I - "$1" "$2" <<'PY'
import ctypes
import errno
import os
import sys

rename = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
if rename is None:
    sys.exit(72)
rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
if rename(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1):
    error = ctypes.get_errno()
    if error == errno.EEXIST:
        sys.exit(17)
    if error == errno.EXDEV:
        sys.exit(18)
    if error in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
        sys.exit(72)
    sys.exit(os.strerror(error))
PY
}

name=${source##*/}
parent=${source%/*}
parent=$(cd -P -- "${parent:-/}" && pwd -P)
source=${parent%/}/$name
destination=$(cd -P -- "$destination" && pwd -P)
exists "$source" || { echo 'Paste source does not exist' >&2; exit 74; }

if [ -d "$source" ] && [ ! -L "$source" ]; then
  ancestor=$destination
  while :; do
    if [ "$ancestor" -ef "$source" ]; then
      printf 'descendant\n'
      exit 0
    fi
    [ "$ancestor" != / ] || break
    ancestor=${ancestor%/*}
    ancestor=${ancestor:-/}
  done
  stem=$7
  extension=
  first=$8
fi

if [ "$mode" = cut ] && [ "$parent" = "$destination" ]; then
  printf 'ok\n%s\n' "$name"
  exit 0
fi

command -v python3 >/dev/null 2>&1 || { printf 'unavailable\n'; exit 0; }
pending=$source
if [ "$mode" = copy ]; then
  stage=$(mktemp -d -- "${destination%/}/.terax-paste-XXXXXXXX")
  trap 'rm -rf -- "$stage" 2>/dev/null || { chmod -R u+rwX -- "$stage" && rm -rf -- "$stage"; }' EXIT
  trap 'exit 74' HUP INT TERM
  pending=$stage/item
  cp -a -- "$source" "$pending"
fi

candidate=$name
for (( attempt=0; attempt<limit; attempt++ )); do
  target=${destination%/}/$candidate
  if ! exists "$target"; then
    status=0
    publish "$pending" "$target" || status=$?
    case "$status" in
      0) printf 'ok\n%s\n' "$candidate"; exit 0 ;;
      17) ;;
      18) printf 'cross-device\n'; exit 0 ;;
      72) printf 'unavailable\n'; exit 0 ;;
      *) exit 74 ;;
    esac
  fi
  if [ "$first" = 1 ]; then
    candidate="$stem copy$extension"
  else
    candidate="$stem copy $first$extension"
  fi
  first=$((first + 1))
done
printf 'names-exhausted\n'
