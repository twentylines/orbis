# Orbis UI inspection

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
