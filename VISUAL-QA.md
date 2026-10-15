# Orbis UI inspection

## 2026-10-15: practical desktop windows

Three independent agents inspected the production bundle with isolated API fixtures. The window matrix covers 24 viewport/mode combinations and 114 geometry samples at 1440/1024/900/768/390/320px, including 540px-high layouts. Final mode assertions pass for full page, floating, maximize/restore and both snaps. Maximized/snapped windows leave exactly 20px below the system bar and above the dock; snap halves have a 16px gap. Pointer drag/resize makes no preference writes during movement and one debounced write after release. Pointer/keyboard cancellation makes none. Bounds survive reload, remain independent per tool and recover after large/mobile/large viewport changes.

The retained `window-flow-checks.cjs` suite passes at 1440/768/390/320 in both modes: unsaved Settings/custom-app/Compose drafts, editor loader suppression, exact route/query/hash restoration, Back/Forward, minimized reload, unrelated uninstall events, app/system log teardown/reconnect, pending retry cancellation, hidden Monitor/Updates polling and global task continuity. Reduced-motion and unavailable-WAAPI runs also pass with zero window animation calls. These log checks use instrumented fixture EventSources; they do not prove production reader teardown on their own.

The route audit covers 46 window/content states, including minimum-width tools, snapped/maximized Monitor/Updates/Store, mobile, menus/dialogs, Docker rankings, Appearance and distribution changelogs. Source repairs include rejected optional placement state, geometry measured during entrance transforms, page-wide dock hiding, native focus outlines, viewport-based layouts inside small windows, a fixed-height Store title and long server subtitles. The final focused bundle verifies rendered Store text separation at 320/520, declared-field appearance import/export and legacy normalization, long labels at 320/390/768/520-window widths, and unchanged snap geometry. Final minimize/restore frame samples are monotonic, use one animation, avoid a competing CSS entrance and restore the exact rectangle.

The full retained route regression exited 0 at 1440/768/390; the final bundle exited 0 at 320. Padding, ignored-update counts, search, history, scoped resources/tasks, install/update forms, dialogs and log limits pass without page errors. Focused final checks refreshed Store captures at all four widths. General route screenshots and representative window captures are in `screenshots/desktop-fixtures` and `screenshots/windows`.

PR 19's protected gates passed frontend/backend/common builds/types, 323 backend tests, common tests, integration and dependency review. Published-image checks are recorded separately in `DEPLOYMENT.md`. These Chrome fixture results do not establish other-browser support, copied-data migration, every inherited recovery flow or full product acceptance.

Reproduce the window flow checks with a bundled local preview on port 8080:

```sh
ORBIS_VISUAL_WINDOWS_ONLY=1 node scripts/visual-qa.cjs
ORBIS_VISUAL_WINDOWS_ONLY=1 ORBIS_VISUAL_NARROW=1 node scripts/visual-qa.cjs
```

## 2026-10-15: Home apps, search and section motion

Independent Chrome inspections cover 1440/768/390/320 CSS px in both modes, with 14 installed apps and long names. Home defaults to 3 apps, selected 4 pins compact the lower cards, and Show all displays 14 in a bounded keyboard/wheel scroller while either lower card is enabled. Hiding both removes the bound; restoring the layout restores the cards. Preferences survive reload after clearing the local cache.

The agents found and the source repairs: editor scrolling before its entrance animation ended; inherited dark muted text; inconsistent long-name picker rows; a 15px launcher inset; top-aligned Applications heading controls; and decorative overflow creating a phantom scroll area. The launcher now clips decoration without becoming a scroll container.

Search opening starts at the actual header trigger (measured 0px endpoint error), fills the workspace, and closes to the live trigger (0 px endpoint error). Interrupted closing continues from the current transform (maximum measured difference below 0.0008 px). Inner input/X/result/footer containment passes after correcting the grid's automatic minimum width. X, Escape, shortcut, focus containment/restoration, installed/catalogue/section routes, delayed/stale results, error/retry feedback, resize during close and rapid shortcuts pass. Empty-result messaging no longer masks search failures.

Section slides follow dock order (+1,+1,-1 measured during forward/back navigation), retain header/dock bounds, and do not run for Settings query changes. The first reduced-motion rule lost to named transition selectors; explicit named overrides now compute animation:none and 0s, with zero active animations. Responsive headers retain the server IP, including the phone status row.

On layouts at least 900 px wide, more than 3 apps place Recent operations and Needs attention beside each other below a shorter launcher pane. Independent checks at 900/901/999/1024/1099/1440px found no header overlap or overflow; the status card no longer acquires a 345 px empty tail.

The retained helpers are `home-app-checks.cjs`, `command-search-checks.cjs` and `workspace-alignment-checks.cjs`, used by `visual-qa.cjs`. These are isolated fixture checks. They do not establish real Docker lifecycle, released image behavior, other-browser coverage or copied-data migration.

Retained release-candidate runs exited 0 for the full 1440/768/390/320 route matrix and the 14-app Home matrix in both modes. All search, geometry, persistence, form, history and focus assertions passed with no page errors. The many-app Home matrix was rerun after the 900px compact-grid refinement, and its screenshots were regenerated at the top of the page with the launcher scrolled to its beginning.

Separate baseline route runs also exited 0 at 3840×2160 CSS px and at 720×1120 CSS px rendered at 2× scale (a 1440px-wide, 200% zoom layout simulation). These passed the retained assertions and had no page errors. This does not establish native browser zoom, text-only enlargement or every inherited flow. Published beta 21 then passed the isolated arm64 OTA, actual saved Home/search interactions, real app start/stop/resources/logs and all 248 icon decodes. Original preferences and stopped app state were restored. `DEPLOYMENT.md` records the release identity and evidence limits.

## 2026-10-15: app workspace and further alignment corrections

Independent agents inspected 96 global route/size/mode states, plus app detail, form, menu and dialog interactions. Production-bundle Chrome checks used isolated API fixtures at 1440, 768, 390 and 320 CSS px in light and dark mode. Screenshots were inspected as well as measured; outer bounds alone missed clipped text and the 3D server's full silhouette.

| Surface | Correction and verification |
| --- | --- |
| Home cards | Title, notice and Docker health use consistent slots. Tablet cards retain enough width for health/notice text. Same-row cards, icons, titles and health baselines align. |
| Home actions | Both actions are 44 px high with centred icon/label groups and identical computed surface, text, border, spacing and shadow styles. Hover/focus preserves bounds; 320 px actions stack at equal full width. Bright inset ridges were removed. |
| Header | All glyphs are 20 px and controls are 40/36 px. Theme hover no longer grows its icon. Long names truncate; configured IP and reconnecting status fit. |
| Dock | Home label and responsive spacing preserve label padding. Visible 390 px labels have at least 8.23 px side insets; narrow layouts show icons with accessible names. |
| Monitor illustration | Complete front/top/side envelope is centred. At 320 px, idle left/right panel spacing measures 19.94/20.07 px; at 390 px, 22.26/22.44 px. Restored hover tilt remains contained. |
| App details | Shared official/custom layout, themed sections/editors and exact-URN resource/operation scope. Keyboard sections, URL history/reload, required install fields, normalized port, read-only Compose/update diff, custom Update/Remove and cancelled backup-removal choice pass. |
| Menus/dialogs | Menu rows are at least 40 px and retain viewport insets. Tablet default dialogs use 720 px; mobile has 16 px insets. Escape restores More; install submission restores the action group when the original button is replaced. |
| Settings | Inherited controls/tables use Orbis tokens. Regional language fallbacks, unique select IDs, keyboard sections and settled back/forward navigation pass. Update copy links to the real Update Center. |
| Command search | Modal keyboard containment and focus restoration pass for Escape, close and shortcut. The newly requested full-workspace morph and catalogue search are subsequent interaction work. |

Notice text contrast measured from rendered pixels is 5.97–6.15:1 light and 8.10–8.22:1 dark. Independent checks found no document overflow or page errors after the targeted corrections.

The retained fixture harness now checks inner button centring, dock-label insets, installed/home card baselines, full server-face bounds and search focus, alongside the previous shell, theme, icon, history and responsive checks. These are local Chrome results. They do not establish released-image behaviour, real Docker lifecycle success, other-browser coverage, a complete enlarged-text pass or production readiness. Published beta 20 completed the browser-reviewed isolated beta 19→20 OTA. Build commit and immutable digest match the release; dark mode, task history and the single Store title survived. A real disposable app started and was restored to its original stopped state. Its invalid log-query check exposed HTTP 200 SSE error responses with the production interceptor; validation still prevented log readers from opening. The next iteration repairs the HTTP boundary and adds the interceptor to the retained HTTP regression fixture.

Final retained harness runs passed at 1440/768/390/320 px with light/dark checks, no page errors and all required geometry/navigation/form assertions true. Desktop, tablet, phone and narrow fixture screenshots were regenerated from that final bundle.

## 2026-10-15: beta 19 corrections

Two independent agents inspected the rendered production bundle. These checks use an isolated browser with development fixtures, not the user's personal browser or Hades.

| Surface | Inspection | Result |
| --- | --- | --- |
| System bar | 320, 390, 761, 768, 820, 1024 and 1440 CSS px; light/dark; top/scrolled; idle, hover and focus | 168 checks passed. Equal control tops/heights; stable mode width; no brand overlap or horizontal overflow. |
| Long server names | Valid long name at 481/520 px, plus 320 px smoke; both modes and each control hovered | 30 checks passed. Label truncates; 11 px interior right spacing remains. |
| Route layouts | Workspace, Apps, Store, Monitor, Settings and Tasks at desktop/mobile; targeted 320 px states | No viewport gaps or horizontal overflow in direct captures. White authored window/button rims were reproduced and removed. |
| Dialogs | 1440/320 px, light/dark; open, Tab, Escape | Single centred frame; focus contained and restored. Conservative muted-text contrast is 4.59:1 light and 7.93:1 dark. |
| Category menus | Keyboard navigation and Escape, both modes | Menu fits viewport; focus returns; no Bootstrap/Radix keyboard-handler conflict. |
| App cards | Desktop row geometry and narrow Store icons | Installed card bottoms align; narrow catalogue icons are 56 px; inline notices remain within cards. |
| Appearance | 320 px, light/dark | Repeated headings removed; server-name input is visible in the initial viewport. |

The outer white margins in the supplied image did not reproduce inside the app in direct browser captures. Root and body backgrounds now explicitly follow desktop mode, including the area exposed by overscroll. This is separate from the bright button/window edges that were reproduced in CSS.

`scripts/visual-qa.cjs` retains regression assertions for header geometry and hover alignment, theme width stability, root background, bulk-controls disclosure, dialog centring/focus, category-menu focus, icon decoding/fallback, layouts, preferences, Docker rankings and history inspection. Focus assertions wait for Radix's asynchronous restoration. Screenshots include expanded controls and overlays as well as the main routes.

## Evidence limits

Chrome was checked locally. Safari/Firefox, touch interaction, every inherited configuration/detail flow, 4K and a complete enlarged-text pass still need acceptance coverage. These checks do not establish production readiness or validate copied Hades data. The full remaining product scope is in `ACCEPTANCE.md`.
