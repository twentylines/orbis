# Orbis changelog

## Unreleased development preview

- Forked Runtipi v4.10.1 while preserving its application and data compatibility surfaces.
- Added the Orbis name, icon, browser metadata, server desktop, command search, App Store presentation, Appearance settings, and a live System Monitor.
- Added authenticated telemetry and per-user desktop preferences.
- Added an Update Center that shows application update availability and reads Orbis release notes from GitHub when releases exist. Host package updates and in-browser Orbis installation are still pending restricted host tooling and rollback validation.
- Verified clean startup, registration, key routes, official catalogue access, and new authenticated endpoints in a disposable Docker VM. Existing-install migration is still pending.
- Replaced inherited upstream release jobs with a gated Orbis image and GitHub Release workflow, and added authenticated installed-build metadata to the Update Center. Published `v0.1.0-beta.1` as an explicitly limited preview.
- Passed a disposable Whoami install, stop, start, restart, backup, reset, restore, and uninstall path. Fixed the default backup list page and removed a tar self-inclusion warning during backup creation.
- Corrected migration inventory for the pinned CLI's top-level folders and `data/postgres`, and added read-only digest/Compose planning for an Orbis release on a copied installation.
- Rehearsed stock CLI v4.10.1 to Orbis and back on a synthetic installation with an account, custom core Compose override, official store, and Whoami app; Hades data remains untested.
- Added low-cost host CPU sampling from `/proc/stat` for the live Monitor, with an explicit container fallback when the host mount is unavailable.
- Added a live CSS perspective server view to Monitor with responsive layout and reduced-motion support.
- Published `v0.1.0-beta.2` with host CPU telemetry and the Monitor server view; verified its immutable arm64 image against a synthetic CLI install.
- Added a guarded release staging command that writes only a digest-pinned core Compose override, plus stricter external-path review in migration preflight.
- Added Ocean and Blush appearance presets and two more bundled local wallpapers, retaining earlier saved preferences.
- Reconciled persisted application statuses against Docker during startup, so a stopped container is not initially shown as running after a core restart.
- Switched the workspace activity tiles to the same live telemetry used by Monitor, with host CPU and memory, clearly scoped core network rates, and runtime filesystem usage.
- Published `v0.1.0-beta.3` with the startup reconciliation fix; verified its arm64 image and an enrolled Orbis host stop/start cycle on a synthetic CLI installation.
- Published `v0.1.0-beta.4` with shared Workspace telemetry and the host command; booted its arm64 image on the synthetic CLI data and verified the inherited account, app record, and store.
- Added Workspace editing for the four widgets and per-user pinning for up to 12 installed applications. Checked desktop, phone, and enlarged text layouts in Chrome.
- Shared telemetry probes across simultaneous browsers with a four-second server cache so each viewer does not trigger duplicate filesystem and network reads.
- Added a read-only release checker that verifies GitHub's release tag and manifest against the exact GHCR image-index bytes and both supported Linux architectures.
- Corrected the Workspace sync label to show a queued save immediately, avoiding a stale “Saved” message during the debounce window.
- Added a locked, journaled host update transaction for an already enrolled Orbis CLI installation. It verifies a published digest, snapshots the stopped tree, restores the previous core on a failed start, and passed a synthetic beta 4 to beta 5 update in the isolated VM.
- Published `v0.1.0-beta.6` and advanced the synthetic CLI installation from beta 5 to beta 6 through that transaction. A real browser check then found that the save label could still briefly show “Saved” after a new pin change. The preference provider now marks the edit as saving in the same event and ignores late responses from older saves; a locally built image passed the same browser interaction.
- Published `v0.1.0-beta.7` with the corrected save state. Its arm64 image passed an enrolled beta 6 to beta 7 update, exact-digest health and snapshot checks, and the real browser pin/save/reload interaction.
- Added a guarded CLI v4.10.1 first-adoption transaction with release verification, stopped-state snapshot, digest-pinned Orbis start, enrollment, and stock rollback. A synthetic stock installation reached published beta 7 with its account and Whoami intact; an injected failure after Orbis start restored stock at the original image ID in the isolated VM.
- Added a restricted Unix socket host service, authenticated core-update API, and Update Center plan/recovery controls. Socket transport, authorization, transaction-state, and responsive review-layout checks pass locally; a published-image browser transaction is still pending.

Real homelab migration, automatic core installation and rollback, host package updates, and multi-server pairing remain outstanding.
