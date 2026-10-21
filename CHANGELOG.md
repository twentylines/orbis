# Orbis changelog

## Unreleased

- Recover interrupted restore files without automatically running the restore again when the queue reconnects. Keep completed outcomes and reject duplicate restore execution.

## Beta60 — 21 October 2026

- Keep backup filenames accessible on narrow screens, give the upload file picker its own space and keep the upload title, close control and footer visible with enlarged text.

- Preserve existing app data permissions when starting, stopping, restarting, updating or regenerating configuration, including after a backup restore. Prepare installation and reset data before startup without changing private files subsequently created by the app.

## Beta59 — 21 October 2026

- Stream uploads to private disk staging instead of holding the archive in memory.
- Validate archive contents and app identity before publishing a backup. Keep uploaded archives private and reject duplicate filenames without replacing existing backups.
- Clean cancelled and failed transfers; retry abandoned temporary-file cleanup on the next upload. Limit app configuration metadata to 1 MiB without imposing a data-size limit on the archive.

## Beta58 — 21 October 2026

- Include MIME detection and GNU tar in the runtime image. Verify binary contents, ownership, permissions and file/directory timestamps through an archive round trip during image builds.
- Stage restores before replacing live directories; retain originals through commit and recover interrupted swaps before app operations or startup.
- Preserve file ownership, modes and timestamps in backup copies. Keep committed recovery state until the database version and stopped state are reconciled.
- Track partial extraction for cleanup and avoid copying app data twice when staging is on the same filesystem. Reject incomplete extraction and copy failures.
- Reflow backup filenames, dates, sizes and actions on narrow screens. Keep long filenames readable and size units together.
- Show the selected backup separately from restore/delete warnings. Scroll long dialog content while keeping the heading and action visible.

## In progress — Updates and compact system-model spacing

- Keep Updates cards at their natural height and separate stacked system readings from the transformed server model. Reflow headings/app rows and CPU/memory columns with enlarged text; preserve accessible long app names. Verify28 native and8 independent doubled-text source compositions after retaining real overflow failures.
- Preserve original browser forwarding exceptions before diagnostic formatting; handle ANSI/malformed URL text safely. Keep incomplete browser runs and their original failure/cleanup flags.

## Beta49 — 18 October 2026

### Process reading position and compact gutters

- Keep the previous CPU sample, explicitly delayed with its original timestamp, while new comparisons are pending. Keep Memory current and replace the old ranking when fresh CPU readings arrive. Initial warmup does not invent previous data.
- Reproduce the preceding end-of-scroll clamp; verify three source viewport/text cases and a composed40-state functional matrix. Match compact Docker/process panel gutters through the shared padding token. The published desktop Monitor refresh preserves exact DOM focus and0px position. Full native/enlarged route acceptance remains unfinished because of verifier failures and manually identified spacing defects; see [actual evidence](screenshots/live-beta49/README.md).

## Beta48 — 18 October 2026

- Add compact-screen type/spacing across tools, app details and auth. Verify32 native compositions, both phone widths/modes with doubled text and20 narrow surface samples. Retain source screenshots and target-size limitations.

### Recovery cache faults

- Reject failed/unreadable SQLite session enumeration instead of treating it as zero sessions. Report partial recovery after a saved password change and retain its request for retry.
- Delete the session value before its index so a failed deletion remains discoverable. Real SQLite connection/DELETE faults prove the preceding failures and successful retry; the new source is not part of beta47.

- Publish both architectures and verify reviewed primary46→48 OTA, stopped snapshot and exact records/28 tasks. Retain the first compact UI rejection: blank Monitor after a failed JS asset request, cause unclassified. Do not infer full UI acceptance from source checks.

## Beta47 — 18 October 2026

- Enforce local recovery password length, current request timestamps, single-process overlap rejection and explicit failed request cleanup.
- Verify actual stock adoption, original password/TOTP retention, hidden-prompt CLI recovery, old-session/password/challenge rejection and unrelated data preservation in a separate arm64 fixture. Four actual browser groups pass112 reads/assets. [Evidence and limits](screenshots/live-beta47/README.md).

## Beta46 — 18 October 2026

- Add current kernel temperature/fan readings and DRM GPU identity to Monitor, with AMDGPU activity/VRAM where supported. Missing, faulted, partial and empty hardware states stay explicit; the restricted helper uses bounded shared reads and no hardware-control commands.
- Refresh sensors every 30 seconds while visible. Preserve focused Docker disclosures through live ranking changes and move focus to Usage if their row disappears.
- Keep wrapped ordinary fallback copy, comfortable disclosure padding, full accessible identifiers and theme-aware warnings. Top bars/titlebars retain the dock's translucent blur without white rims.
- Verify the published arm64 update, private stopped snapshot, exact saved records and five actual native/enlarged browser groups. The VM exposes no physical sensor/GPU devices; numerical hardware acceptance remains open. See [current release evidence](screenshots/live-beta46/README.md).

## Unreleased development preview

- Enforce the normal password minimum and a current fifteen-minute decimal timestamp for local operator recovery. Reject overlapping resets, preserve retry after early failures and report failed request cleanup after updating the password and revoking sessions. CLI-only authorization is retained; published CLI acceptance remains separate.

- Correct the host-device cache deadline found by beta44's real no-browser gate. Expire successful results from request start before the next history tick, retaining request coalescing and unavailable-result backoff; reject the old policy with real-service/timer regressions.

- Add bounded individual host disk/interface history with private restart-safe storage, device/range links, measured averages/peaks/counts and explicit coverage/storage states. Keep hidden browser polling paused and device focus stable during refresh and delayed selections.
- Give compact charts a full-width plot with the scale above it. Preserve the surviving Retry button after repeated failures in host devices, device history and host processes.

- Stop inherited smooth page scrolling from racing native keyboard focus behind the dock. Preserve explicit section and search motion.
- Size history-chart axes to their labels, wrap timestamps and place inspection details below the plot. Keep missing values readable and strengthen theme-aware small-label contrast.

- Add a Host devices section in Monitor with real Linux filesystem capacity, interface counters/rates/link state and whole-device disk activity through the restricted helper. Bound and share collection, reject unsafe responses and show stale/partial/missing capabilities explicitly. Keep core-container readings separate.
- Wrap mount labels at directory boundaries, use accessible ellipsis for long identifier segments, reflow device facts with enlarged text and preserve keyboard focus after Retry. Keep initial collection responsive without adding continuous background browser polling.

- Add Follow system colour mode without replacing the chosen preset. Track device changes across status instruments, desktop/auth/guest/recovery surfaces, notifications and editors; keep the raw account/export preference as system and avoid preference writes for device changes.
- Guard language detection, theme cookies and preference storage when JavaScript storage access fails. Keep the page usable and report whether changes are synced, cached or temporary. Let mode cards reflow with enlarged text.

- Align installed app, custom-link and action-card rows at every column count. Share Store filter/card gutters, keep complete app copy and wrap long links without orphan letters. Scale the notice reserve with text so Docker health labels stay aligned.
- Recheck unfinished GitHub release manifests after 30 seconds while retaining the normal cache for ready releases.
- Return HTTP400 for incorrect, expired or reused authenticator challenges and incorrect enrollment codes; preserve HTTP429 after repeated invalid attempts.

- Label new authenticator enrollments Orbis, retain existing encrypted TOTP verification, and use Orbis in origin errors. Remove raw authentication headers and redirect/query credentials from debug logging. Omit absent login redirects before response validation.
- Update the API generator and regenerate its runtime templates to prevent parameter prototype substitution. Update translation URL validation and check normal request transport, preserved SDK routes and rejected unsafe language/namespace values.
- Fill custom workspace rows while preserving wide/normal proportions. Remove forced launcher blank height; retain the default layout and contained all-app scrolling. Check native and doubled text across four widths and seven arrangements.
- Raise the ORM's minimum version past the quoted-identifier security fix; lock both workspaces to 0.45.4 and verify embedded quotes in PostgreSQL identifiers and aliases. Remaining generator/translation dependency work is recorded in `DEPENDENCY-SECURITY.md`.
- Keep desktop headers outside the section animation snapshot so backdrop blur samples the wallpaper; retain directional content slides and phone page transitions.
- Remove bright white chrome rims and nested corner seams. Give top bars and coloured desktop headers the dock's palette-aware glass blur, with a readable opaque fallback.
- Make System status surfaces, labels and 3D server materials follow light/dark mode and colour presets. Theme Monitor retry messages and meters; preserve semantic live/stale indicators.
- Prevent desktop frame focus from scrolling a fixed header under its rounded edge. Retain internal tool scrolling and the separate whole-frame fallback for tall headers; verify settled capture geometry and Home scroll restoration.
- Serialize preference saves and coalesce superseded queued values instead of aborting mutations in flight. Skip redundant saves after account load and retain explicit failure/recovery feedback.
- Package required runtime dependencies from the frozen Bun install, preserving resolved transitive versions. Verify native hashing and transformation under the production Node runtime during every image build.
- Align Settings title icons, tabs, dividers and forms to one gutter. Remove inherited negative tab margins and keep the divider below all tab rows. Preserve whole Appearance labels with enlarged text and reveal page controls clear of the sticky bar and dock.
- Reserve window navigation for large screens. Phones, tablets and short viewports use full-page sections, compact headings and normal document scrolling. Resizing preserves form drafts and saved desktop placement; small screens open minimized desktop links as visible pages.
- Keep large-screen tools between the system bar and dock, with content scrolling inside the window. Enlarged desktop chrome can use the whole window as its scroller. Preserve the reading position through minimize/restore.
- Restore store-dialog focus to a surviving panel after deletion or when a pending operation has disabled its opener. Keep the focused control visible when refreshed rows move it. Retained checks cover native wheel/Tab, delayed list refresh and closing pending add/edit/delete requests.
- Bound app-store Git transfers with a 30-second network idle limit and a ten-minute clone/fetch deadline. Cancellation aborts the transfer, waits for Git to settle and keeps repository locks through staging cleanup; failed refreshes retain the working checkout.
- Verified published beta31 store failure and retry against real APIs and controlled Git/filesystem faults. Updated phone captures record retained inline errors and exact configuration/data preservation after native Compose restoration.
- Reflowed long Home headings, search results, Select menus, log controls, security fields and nested installer/Compose forms. Ordinary labels wrap between words; identifiers keep full accessible names. Compose table actions retain a complete keyboard focus marker inside their scroll area.
- Verified a real custom-store v2 to v3 upgrade on the isolated server: the backed-up update stayed stopped, preserved settings and overrides, generated the new default before an explicit healthy two-service start, and returned to stopped state.
- Aligned Home with the system bar's inner column, made logout clearance symmetric, replaced sample timestamps with system uptime and renamed Docker rankings to Usage.
- Removed the login language selector's inherited bottom margin so it aligns with the theme toggle. Auth checks now measure both controls' heights and centre lines.
- Reflowed two-factor code inputs into equal columns with enough inner width for entered digits on narrow screens.
- Retained safe update failure diagnostics through rollback and helper restarts. Backup read/copy/change/mismatch/seal failures now have separate messages; strict content and permission verification remains enforced.
- Replaced oversized error panels with compact recovery actions and expandable diagnostics; route navigation resets the error boundary. Widened the desktop with24px insets and kept ultra-wide Settings forms in one readable window.
- Fixed enlarged-text clipping in Home actions, resource/storage rows, app tabs, pins and dock labels. Keyboard focus now reveals a complete dock item. Login attribution, placeholders, reset instructions and empty-state glyphs use the active theme.
- Preserved stored app settings and backup retention during upgrades, generated new app defaults inside the update task, and persisted fresh-install retention overrides.374 backend and78 common tests pass; released app-upgrade preservation remains a separate acceptance check.


- Added saved floating/maximized/snapped tool windows, pointer/keyboard move/resize, mobile fallback and minimize/restore that preserves the current form and URL. Hidden tools pause their polling and log streams; global events and tasks stay live.
- Corrected content-width layouts, long Store headings/server labels, create/edit/update titles, input label associations, system-log IDs/limits and ignored-update attention counts. Independent window geometry, flow, motion and screenshot checks pass.
- Added strict window-state persistence, visibility-only editor loader guards and declared-field preference import/export. The current single-tool model and remaining acceptance scope are documented in `DESKTOP-WINDOWS.md` and [release notes](https://github.com/twentylines/orbis/releases).

- Added a saved show-all Home app mode, a direct pin picker and automatic compaction of Recent operations/Needs attention. App scrolling stays contained while either lower widget is enabled.
- Added directional section slides and a full-workspace search expansion with installed apps, catalogue apps and Settings/Updates destinations. Keyboard, interrupted motion, error/retry states and reduced-motion support passed independent browser inspection.
- Moved log-query validation ahead of SSE interceptors so invalid requests return HTTP 400 JSON before headers or readers open. The regression fixture now includes a production-like interceptor.

- Redesigned official/custom app details around shared actions, Docker health, scoped resources and operations. Fixed section history/keyboard navigation, custom Update routing, missing custom Remove access and destructive-dialog backup-choice reset.
- Aligned Workspace action buttons, app-card title/notice/health slots and header glyphs. Hover and focus feedback now preserve their geometry. Improved menus, tablet dialogs, backup empty states and light/dark editors after independent browser inspections.
- Fixed stale log-stream retries after navigation and validated authenticated log requests before opening readers, with a 1–1000-line limit.

- Corrected header hover alignment, toggle width changes and tablet overlaps; removed bright white rims and double dialog frames. Dialogs and menus now share Orbis tokens. Simplified Appearance and app controls after independent visual audits.

- Added bounded server-side metric history with seven-day retention, inspectable charts, measured downsampling and responsive Monitor ranges. Full outstanding acceptance requirements are tracked in [release notes](https://github.com/twentylines/orbis/releases).

- Fixed the exposed strip above the desktop, widened chrome/window insets, removed duplicate route titles, and combined storage with System status. Recent operations now sits beneath the launcher.
- Added Docker health beside installed apps, shared per-container telemetry, CPU/memory consumer rankings, and persistent lifecycle task history. The isolated icon audit decoded 248 app icons successfully.
- Forked Runtipi v4.10.1 while preserving its application and data compatibility surfaces.
- Added the Orbis name, icon, browser metadata, server desktop, command search, App Store presentation, Appearance settings, and a live System Monitor.
- Added authenticated telemetry and per-user desktop preferences.
- Added an Update Center that shows application update availability and reads Orbis release notes from GitHub. Its reviewed Orbis core update path now runs through a restricted host service; host package updates remain pending.
- Verified clean startup, registration, key routes, official catalogue access, and new authenticated endpoints in a disposable Docker VM. Migration of actual homelab data remains pending.
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
- Added a restricted Unix socket host service, authenticated core-update API, and Update Center plan/recovery controls. The browser completed published beta 9 → beta 10 and beta 10 → beta 11 transactions on the isolated arm64 installation.
- Added a guarded first-install tool for the Linux host service on an already enrolled core. It verifies the published image, read-only socket mount, and matching host/container inode before installing private root-owned scripts and enabling systemd. A unit restart and full VM restart preserved socket access.
- Published beta 11 with a dock-free Monitor and Update Center detail layout and accessible changelog scrolling. Chrome verified the running image at desktop and phone widths with live telemetry, full release notes, no horizontal overflow, and no page errors.
- Rebuilt the beta 16 desktop around a bundled alpine horizon, open app launchpad, floating dock, window chrome, and live instrument panel, with coordinated motion and reduced-motion support.
- Added a per-account light/dark switch in the system bar and Appearance. Existing Graphite settings retain dark mode; the new visual pass gives system dials, storage, and operations more depth. Desktop, phone, and 320px screenshots now cover both modes.

Real homelab migration, a production-ready installation and helper-upgrade path, host package updates, and multi-server pairing remain outstanding.
