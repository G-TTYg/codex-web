# ADR: Use one fail-closed semantic Desktop patcher

- Status: accepted
- Date: 2026-08-06

## Context

Earlier macOS/Linux builds applied unified diffs to prettified, fingerprinted
Desktop chunks, while the Windows fork used a separate semantic transformer.
Recent Desktop releases merged many renderer modules into `app-initial` and
changed chunk fingerprints and formatting without necessarily changing the
underlying contracts. Maintaining two patch systems made platform behavior
drift likely and turned routine releases into large textual patch rewrites.

## Decision

All hosts use `scripts/patch-desktop-asar.mjs` after converging on the same
selectively extracted ASAR layout. Each transformation discovers its target
through multiple behavior anchors, requires a unique pre-patch match, recognizes
the exact post-patch form, and fails on missing or ambiguous contracts.

Platform scripts own only official Desktop discovery and archive extraction.
Renderer behavior is not allowed to diverge by host.

## Consequences

- macOS, Linux, and Windows receive the same browser compatibility behavior.
- Fingerprinted filename churn no longer requires patch-file regeneration.
- Minified semantic anchors still require deliberate maintenance when upstream
  implementation changes.
- Formatting-only changes can still invalidate a replacement; this is an
  intentional signal to review the new bundle instead of silently continuing.
- The legacy `patches/` unified diffs are removed so there is one authoritative
  implementation.
