# 在 WSL 发行版内部探测实际业务依赖，不检查宿主 Rust 提供的搜索能力。
set -u
LC_ALL=C

printf 'TERAX_CAPABILITIES_V1\000'
terax_emit sh ready ''
terax_simple_probe bash bash bash -c 'exit 0'
terax_simple_probe setsid setsid setsid --wait /bin/sh -c 'exit 0'
terax_simple_probe find find find /dev/null -maxdepth 0 -printf ''
terax_simple_probe stat stat terax_check_stat
terax_simple_probe awk awk awk 'BEGIN { exit 0 }'
terax_begin_probe
terax_probe_paste
terax_probe_git
terax_probe_archive

if [ -n "$probe_dir" ]; then
  : >"$probe_dir/write-source"
  : >"$probe_dir/write-target"
fi
terax_probe_in_temp chmod_reference chmod chmod --reference="$probe_dir/write-source" "$probe_dir/write-target"
terax_probe_in_temp ln_create ln ln -- "$probe_dir/write-source" "$probe_dir/write-link"
terax_probe_in_temp mv_force mv mv -f -- "$probe_dir/write-source" "$probe_dir/write-target"
terax_simple_probe sha256sum sha256sum sha256sum -- /dev/null
terax_probe_sha256
printf 'END\000'
