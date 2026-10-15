# Orbis acceptance record

The original product brief and subsequent user requests remain the scope. A published beta is an iteration, not completion of this checklist. Evidence refers to the current implementation; historical notes in `DEPLOYMENT.md` describe individual rehearsals.

| Requirement | Current evidence | Work still required |
| --- | --- | --- |
| Runtipi compatibility, authentication, lifecycle, stores, configuration, data, networking, HTTPS, backups and attribution | Upstream v4.10.1 retained; feature inventory; isolated lifecycle and synthetic adoption/rollback; original account/app/store survive released updates | Copied real-data migration, custom-store refresh and app-update rehearsal, TOTP/forward-auth/HTTPS end-to-end checks, external mounts and volumes, amd64 runtime |
| Cohesive server desktop and glass materials across screens | Shared chrome/dock/windows, local wallpaper, distinct content materials; desktop/mobile/narrow screenshots | Deeper store/detail/form presentation, consistent menus/dialogs/loading/error states, tablet/4K and enlarged-text audit across every flow |
| Useful editable home workspace | Real installed apps/links, pinning, status/storage/network, recent operations and attention; saved show/hide/order/width controls | Application groups and recent-use ordering, additional widgets and presentation options, drag/resize with keyboard alternatives |
| Integrated real monitoring | Host CPU/per-core/memory/swap/uptime when exposed; runtime storage/network; real per-container resources and health; CPU/memory rankings; bounded recorded aggregate history, time ranges and pointer/keyboard chart inspection | Host disks/network/I/O, exposed sensors/GPU, host-process consumers, precise source/staleness treatment |
| App store and app management | Existing catalogue/search/categories/stores/forms/actions retained; all 248 catalogue/installed icons decoded on beta 18; real disposable app lifecycle; shared official/custom detail workspace with exact-app resources and operations, URL-driven sections and themed editors | Update/custom-store/architecture/error/recovery coverage, remaining edit/update forms and populated backup presentation |
| Persistent task centre | Real queue request IDs, phases/outcomes/timestamps survive restart and beta 17→18 OTA; logs links; missing outcomes are explicit | More granular real worker phases and scoped logs where available, useful notification integration |
| Practical desktop window model | Focused route panels, command palette, browser navigation | Focus/resize/minimise/maximise/snap, restored bounds, mobile touch/full-screen behaviour, safe third-party launch and framing coverage |
| Complete personalisation | Saved light/dark, six presets, bundled wallpapers, density, workspace settings and validated non-secret export/import | Follow-system, accent, validated local wallpaper uploads and positioning/dimming/blur, bounded glass controls, text scale, dock placement/size/auto-hide/pins, effect preferences; full theme packs affect all surfaces and remain a later phase |
| Motion, loading, accessibility and performance | Purposeful CSS motion, reduced-motion rules, bounded/shared collectors, background browser polling suspended, focus styles | Consistent skeletons and permission/reconnect states, focus restoration, chart keyboard inspection, contrast across all presets, attractive reduced-transparency/low-effects mode, comprehensive responsive checks |
| Supporting tools after the core | Stock scoped app/instance logs and backups; reviewed core and Ubuntu package updates | Searchable scoped logs, notifications/thresholds; files/terminal only with explicit safe scope and real integration |
| Secure reversible deployment and OTA from GitHub | Protected PR gates; digest-pinned amd64/arm64 publication; stopped-tree snapshots, recovery and stock rollback; systemd helper setup/upgrade; real browser OTA and package install on isolated arm64 | Supported clean-install/adoption experience for real homelabs, external data backup handling, copied-data and independent-backup rehearsal, production approval and validation |
| Multiple homelabs | Controller/agent and pairing requirements recorded in `MULTI-HOMELAB.md` | Later implementation and two-isolated-host testing, target-aware app install/launch, merged dashboards, disconnect/revoke/restart handling and efficient multi-server visualisation |
| Final deliverables | GPL licence, upstream record, source/release repo, setup/migration notes, screenshots and test records | Reconcile instructions with final supported behaviour, complete requirement-by-requirement production acceptance audit |

## Current iteration: application workspace and alignment

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

Local verification: measured background collection with every Orbis page closed; saved history survived a VM restart; an explicit core restart flushed the unsaved partial minute. Authenticated browser range selection, reload, keyboard inspection and desktop/mobile fit passed on the isolated arm64 build. Published-image verification follows the protected release gates.
