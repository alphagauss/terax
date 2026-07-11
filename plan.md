# File tab sidebar context

## Goal

When a file opened from the sidebar becomes active, restore the sidebar root
that was active when it was opened and select that file in the tree. Do not
change any terminal session's working directory.

## Approach

- Store the sidebar root on editor and markdown tabs opened from the explorer.
- Prefer that stored root while the corresponding file tab is active.
- Reveal the file by expanding its ancestor directories, then select and scroll
  it into view after a root change.
- Persist the optional root with Space tab state and authorize it at restore.
- Reuse the shared path and workspace-environment flow for Local, WSL, and SSH.

## Verification

- Add serialization tests for file-tab sidebar roots.
- Add explorer-root resolution and file-reveal helper tests.
- Run frontend lint, type checks, and tests.
