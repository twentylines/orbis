# Orbis acceptance record

The original product brief and subsequent user requests remain the scope. A published beta is an iteration, not completion of this checklist. Evidence refers to the current implementation; historical notes in `DEPLOYMENT.md` describe individual rehearsals.

| Requirement | Current evidence | Work still required |
| --- | --- | --- |
| Runtipi compatibility, authentication, lifecycle, stores, configuration, data, networking, HTTPS, backups and attribution | Upstream v4.10.1 retained; feature inventory; isolated lifecycle and synthetic adoption/rollback; original account/app/store survive released updates; published amd64 clean-install/lifecycle/window/icon rehearsal | Copied real-data migration, custom-store refresh and app-update rehearsal, TOTP/forward-auth/HTTPS end-to-end checks, external mounts and volumes |
| Cohesive server desktop and glass materials across screens | Shared chrome/dock/windows, local wallpaper, distinct content materials; desktop/mobile/narrow screenshots | Deeper store/detail/form presentation, consistent menus/dialogs/loading/error states, tablet/4K and enlarged-text audit across every flow |
| Useful editable home workspace | Real installed apps/links, pinning, status/storage/network, recent operations and attention; saved show/hide/order/width controls | Application groups and recent-use ordering, additional widgets and presentation options, drag/resize with keyboard alternatives |
| Integrated real monitoring | Host CPU/per-core/memory/swap/uptime when exposed; runtime storage/network; real per-container resources and health; CPU/memory rankings; bounded recorded aggregate history, time ranges and pointer/keyboard chart inspection | Host disks/network/I/O, exposed sensors/GPU, host-process consumers, precise source/staleness treatment |
| App store and app management | Existing catalogue/search/categories/stores/forms/actions retained; all 248 catalogue/installed icons decoded on beta 18; real disposable app lifecycle; shared official/custom detail workspace with exact-app resources and operations, URL-driven sections and themed editors | Update/custom-store/architecture/error/recovery coverage, remaining edit/update forms and populated backup presentation |
| Persistent task centre | Real queue request IDs, phases/outcomes/timestamps survive restart and beta 17→18 OTA; logs links; missing outcomes are explicit | More granular real worker phases and scoped logs where available, useful notification integration |
| Practical desktop window model | Published beta 22: full-page and floating route tools; pointer/keyboard move/resize, minimize/restore, maximize/snap, private per-tool placement, mobile fallback; real API/browser window and native-log checks | Safe third-party launch and framing coverage; more than one retained tool window at a time is not implemented |
| Complete personalisation | Saved light/dark, six presets, bundled wallpapers, density, workspace settings and validated non-secret export/import | Follow-system, accent, validated local wallpaper uploads and positioning/dimming/blur, bounded glass controls, text scale, dock placement/size/auto-hide/pins, effect preferences; full theme packs affect all surfaces and remain a later phase |
| Motion, loading, accessibility and performance | Purposeful CSS motion, reduced-motion rules, bounded/shared collectors, background browser polling suspended, focus styles | Consistent skeletons and permission/reconnect states, focus restoration, chart keyboard inspection, contrast across all presets, attractive reduced-transparency/low-effects mode, comprehensive responsive checks |
| Supporting tools after the core | Stock scoped app/instance logs and backups; reviewed core and Ubuntu package updates | Searchable scoped logs, notifications/thresholds; files/terminal only with explicit safe scope and real integration |
| Secure reversible deployment and OTA from GitHub | Protected PR gates; digest-pinned amd64/arm64 publication; stopped-tree snapshots, recovery and stock rollback; systemd helper setup/upgrade; real browser OTA and package install on isolated arm64 | Supported clean-install/adoption experience for real homelabs, external data backup handling, copied-data and independent-backup rehearsal, production approval and validation |
| Multiple homelabs | Controller/agent and pairing requirements recorded in `MULTI-HOMELAB.md` | Later implementation and two-isolated-host testing, target-aware app install/launch, merged dashboards, disconnect/revoke/restart handling and efficient multi-server visualisation |
| Final deliverables | GPL licence, upstream record, source/release repo, setup/migration notes, screenshots and test records | Reconcile instructions with final supported behaviour, complete requirement-by-requirement production acceptance audit |

## Current iteration: compact errors and responsive layouts

The supplied error screenshot revealed excessive fixed whitespace and an isolated route-path box. The replacement uses intrinsic height, aligned recovery actions and an expandable Details section. The system bar, Home, full-page tools, search and notifications share a 24px outer inset. Login attribution and placeholders follow the active theme.

Independent enlarged-text inspection identified six additional layout defects in Home actions, storage/resources, pins, dock labels, app tabs and window titles. Targeted source repairs let the content reflow; full labels remain reachable in a scrolling dock. Visual verification is recorded in `VISUAL-QA.md`.

A real beta24 custom-store upgrade reached a healthy v2 container but exposed a backup-retention change. Source regressions now preserve stored retention and other app settings, save fresh-install retention and generate the new environment within the update task. Backend374 tests and common78 tests pass. A released-image rerun remains required before claiming the custom-store upgrade path fully verified. New catalogue force-expose/exposability/domain compatibility needs a deliberate preflight; automatic source rollback is not implemented.

## Previous iteration: application workspace and alignment

- Consolidate official and custom application details into one responsive workspace, with lifecycle state, Docker health, actions and installed-version facts.
- Scope container resources and operations by the complete application URN. Preserve global Monitor and Tasks views.
- Keep section selection in the URL, including keyboard navigation, history and reload. Preserve install/update/configuration/backup/reset/remove semantics.
- Close stale log streams and pending reconnects on section/app changes; bound log requests to 1–1000 lines and validate them before opening a reader.
- Correct the user's home-screen alignment findings: equal action heights and interior centring, stable hover/focus bounds, matching header glyph sizes, and shared title/notice/health slots in app cards.
- Inspect rendered tabs, files, empty backups, menus and dialogs at desktop, tablet, phone and narrow widths in both modes. Refresh screenshots and publish through protected GitHub checks.

The isolated Chrome fixture checks exercise required install fields, normalized ports, generated Compose and update-diff read-only behaviour, default update backups, custom update routing, custom Remove access, cancelled destructive actions and backup-choice reset. Real homelab migration and a complete product acceptance audit remain pending.

## Previous iteration: server metric history

This iteration also addresses the user's UI inspection findings. Header geometry, contextual borders, shared dialog/menu theme tokens, app controls and Appearance were corrected after independent browser audits. See `VISUAL-QA.md` for the tested matrix and remaining browser/flow limits.

1. Record CPU, host memory and core-network readings independently of an open browser, using the existing shared collector.
2. Keep ten-second samples in a bounded memory buffer and seven days of minute aggregates in a private, append-only journal. Compact periodically, preserve corrupt storage, and report persistence failures.
3. Serve authenticated, strictly validated 5-minute/1-hour/24-hour/7-day ranges with bounded output and honest gaps/source changes. Downsample from measured samples only.
4. Add readable time axes and pointer/keyboard chart inspection. Distinguish current readings, averages, peaks and unavailable values.
5. Verify aggregation, retention, restarts, storage failure/corruption, authentication, browser navigation/reload, range controls, gaps and responsive layouts. Publish through the protected GitHub workflow and test the released image in the isolated VM.

Hades remains reserved for the separately approved deployment phase. No production Docker daemon or data tree is used for development.

## Previous iteration: desktop interaction and Home apps

Published as beta 21. Protected checks and the isolated arm64 browser OTA passed; actual saved Home/search interactions, app lifecycle/resources/logs and all 248 icon decodes passed. Original preferences and stopped app state were restored.

- Use smooth, directional section slides with consistent easing and reduced-motion support.
- Make app pinning easy to discover; add saved show-all home mode. More than three visible apps compact Recent operations and Needs attention; both widgets remain independently hideable/restorable. When those widgets are enabled, the app list uses a contained scroller.
- Expand search fluidly from the system-bar control into the workspace, covering installed apps, catalogue apps and UI sections. The close button reverses the transition, and keyboard focus returns to the search control.
- Keep one button design language, sufficient dock-label padding, and show the configured server IP in the connection status. Recheck all rendered controls after these changes.

Local verification: measured background collection with every Orbis page closed; saved history survived a VM restart; an explicit core restart flushed the unsaved partial minute. Authenticated browser range selection, reload, keyboard inspection and desktop/mobile fit passed on the isolated arm64 build. Published-image verification follows the protected release gates.

## Previous iteration: practical desktop windows

- Provide full-page, floating, maximized and snapped tools with consistent title-bar controls, saved per-tool bounds and keyboard alternatives. Clamp to the actual workspace; mobile uses full-page tools.
- Preserve the current route and unsaved form during minimize/restore. Keep app tabs, Monitor ranges and unrelated query values. Do not re-run editor loaders for a visibility-only navigation.
- Pause hidden-tool log readers, retries, metric history and polling. Keep global app events and task state live. Avoid unrelated app events discarding another tool's draft.
- Adapt content to window width, including Store cards, Monitor, resource rankings, Updates and Appearance. Inspect internal scrolling, menus/dialogs, focus and all controls in both modes.
- Correct system-log line IDs and bounds, accessible input labels, contextual create/edit/update titles and ignored-update Home counts.

See `DESKTOP-WINDOWS.md` for route/state semantics. Beta 22 publication, reviewed OTA, snapshot comparisons, real window/app/log/search checks and all 248 icon decodes passed on the isolated arm64 stack. `DEPLOYMENT.md` records the startup-health audit race and its independent settled verification. This iteration does not complete the full acceptance checklist.

## Current iteration: store refresh and app upgrades

- Preserve a last-good catalogue on an unavailable Git server; stage first clones and clean failures. Serialize operations on each repository.
- Report partial refresh failures, remove duplicate pulls and preserve offline startup using local files.
- Keep the app update review stable while requests load. Handle HTTP, missing-file and malformed-Compose failures with visible retry and gated submission. Keep the wizard on an HTTP rejection.
- Verify native keyboard step activation, backup choice, minimize/restore, narrow footer geometry and consistent focus treatment.
- Rehearse a real owned custom store and app version upgrade with persistent data, app configuration, user Compose/env overrides, generated values and backup evidence. Boot the published image in a separate x86_64 guest and run the clean-install/lifecycle checks.

The source regression suite passes 354 backend tests and the common tests; types and bundle pass. The existing Tasks HTTP test failed intermittently while repeatedly opening/closing its listener; it now keeps one explicit loopback listener per test and the full suite passed. Beta 22 also passed clean registration, eight app lifecycle actions, real window checks and all 264 icon decodes in a separate x86_64 guest; see `DEPLOYMENT.md`. Custom-store upgrade evidence will be recorded after verification. The final bundle passed the full 1440/768/390 route regression, 60 connection-state assertions and the update wizard at 1440/768/390/320 in both modes, including 112 footer geometry checks and 64 review failure/retry recoveries. Hades remains unchanged.
