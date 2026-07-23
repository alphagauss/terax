# Third-party notices for Remote SSH and file transfers

The Remote SSH implementation in Terax was produced from the three reference
projects listed below. The code was reorganized, reduced, and modified to fit
Terax's Tauri workspace, filesystem, PTY, shell, Git, and React interfaces.
Terax does not require these repositories at build time or runtime.

## fs2

- Project: fs2, https://github.com/danburkert/fs2-rs
- Version: 0.4.3
- Author: Dan Burkert
- License: MIT OR Apache-2.0; Terax uses the Apache-2.0 option.
- Used for cross-platform advisory file locks protecting Workspace identities,
  AI session runs, shared JSON mutations, and the Linux secrets fallback.

The Apache License 2.0 text is included in the root `LICENSE` file.

## CrabPort

- Project: CrabPort, https://github.com/chi11321/CrabPort
- Reviewed revisions: `8666047ebd6e72bd1ee9b04b08204f114a818361`,
  `1d66518`
- License: Apache License 2.0
- Used as the main reference for the SSH/SFTP/proxy/tunnel module boundaries,
  proxy transport, transfer operations, and connection/tunnel lifecycle.
- Relevant Terax files: `src-tauri/src/modules/remote/proxy.rs`, `sftp.rs`,
  `tunnel.rs`, `manager.rs`, and `models.rs`, plus
  `src-tauri/src/modules/transfers/archive.rs` and `transfers/ssh/archive.rs`.
- Modifications: removed the GPUI/application persistence layers, consolidated
  the crates into the Terax backend, replaced project-specific DTOs, and wired
  the operations into Terax's existing commands and workspace model.

The Apache License 2.0 text is included in the root `LICENSE` file.

## Eussh

- Project: Eussh, https://github.com/WillSat/eussh
- Reviewed revision: `43174993bed3b4f81d65c75aba3139beaecb5dac`
- Copyright: Copyright (c) 2026 Eussh
- License: MIT
- Used as the reference for the russh session/channel flow, host-key prompt,
  Tauri commands/events, and xterm-compatible terminal bridge.
- Relevant Terax files: `src-tauri/src/modules/remote/session.rs`,
  `host_key.rs`, `terminal.rs`, and `commands.rs`.
- Modifications: replaced the Vue/event terminal path with Terax raw IPC
  channels, added shared SFTP/tunnel services, and adapted lifecycle and state
  ownership to the existing Terax PTY and workspace stores.

MIT License

Copyright (c) 2026 Eussh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## meatshell

- Project: meatshell, https://github.com/jeff141/meatshell
- Reviewed revisions: `8c5eeef7b4f0326644606aef3c5a89bfec342455`,
  `d4246a9`
- Copyright: meatshell contributors
- License declared by its Cargo package: MIT OR Apache-2.0. Terax uses the
  Apache-2.0 option for the adapted material.
- Used as the reference for OpenSSH config parsing, known-host behavior,
  password/private-key/agent authentication details, recursive SFTP transfer,
  keepalive, outbound proxy options, and local/remote/dynamic forwarding.
- Relevant Terax files: `src-tauri/src/modules/remote/ssh_config.rs`,
  `host_key.rs`, `session.rs`, `sftp.rs`, and `tunnel.rs`, plus
  `src-tauri/src/modules/transfers/ssh/`.
- Modifications: removed the Slint UI and all Telnet/serial/XMODEM features,
  moved secrets to Terax's OS credential-vault commands, and adapted the
  remaining behavior to russh and Terax's workspace APIs.

The Apache License 2.0 text is included in the root `LICENSE` file.

## Scope retained in Terax

The migrated implementation is self-contained in this repository. Its current
remote-host contract is Linux with bash as the account login shell. The three
reviewed repositories are provenance and design references only; no absolute
local path, source checkout, build step, or runtime lookup depends on them.
