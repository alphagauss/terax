# Remote SSH terminal cwd to sidebar

## Goal

Make the sidebar file tree follow the active Remote SSH terminal directory,
matching Local and WSL behavior without persisting Terax hook files on the
remote host.

## Approach

- Reuse the existing Bash OSC 7/OSC 133 integration script.
- Remote SSH already supports Linux hosts with Bash login shells only, so start
  each remote PTY through interactive Bash with that script as its inline
  `--rcfile`.
- Preserve the requested cwd with `cd -- <cwd>` before `exec`.
- Pass the existing Terax terminal environment flags, including blocks mode.
- Leave the frontend cwd-to-explorer and SFTP tree paths unchanged.

## Verification

- Rust unit tests cover the generated remote Bash command for home, nested
  paths, shell quoting, and blocks mode.
- Run focused Rust tests, then Rust formatting, clippy, and the full Rust test
  suite when the environment permits.
