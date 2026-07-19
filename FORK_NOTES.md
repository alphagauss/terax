# Upstream Tracking

- Upstream repository: https://github.com/crynta/terax-ai.git
- Tracked upstream branch: `upstream/main`
- Initial base commit: `78a0b3dd79554ad4af89e61d97004f3475cd9953`

## Sync policy

This project is an independent downstream fork. Upstream changes are reviewed and selectively ported rather than merged wholesale.

## Update workflow

For each upstream review, create a temporary branch and add a temporary update section to this file. Keep it current throughout the review so downstream adaptation can continue across multiple work sessions.

The temporary section must record:

- The temporary branch, tracked upstream branch, and reviewed commit or range.
- Each selected, skipped, or deferred upstream change and the reason for that decision.
- Downstream-specific adaptations, fixes, unresolved issues, and follow-up work.
- Verification already completed and any remaining merge blockers.

When the update is complete and ready to merge into downstream `main`, remove the temporary details and retain only the concise entry under Sync history.

## Sync history

- 2026-07-10: Synced selected upstream changes into downstream `main` at `6bdcd1ed40b633dfabb859957a8fcd8d9f8e5f7c`.
- 2026-07-14: Reviewed `upstream/main` through `a2c8329662ade6fef8c1e11f7353a7231256937d` and ported the accepted changes on `chore/upstream-merge-review-2026-07-14`.
- 2026-07-19: Reviewed `upstream/main` through `fcff6c5`, cherry-picked `fcff6c5`, manually ported `ac88362`, and removed the stale Star History embed. Deferred agent-tab status, `5c2f4cd`, Pi support, alert collapse, and SignPath attribution.
