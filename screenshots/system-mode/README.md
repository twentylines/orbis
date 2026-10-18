# Follow system and storage recovery

Compiled-source Chrome fixtures, 18 October 2026. These are browser-only API responses on static port 8080, separate from published beta40 and any real homelab. Hades is unchanged.

[Assertions](assertions.json) · [Light Appearance](1440-light-native.png) · [Dark Appearance with doubled text](1440-dark-text200.png) · [Tablet with doubled text](768-dark-text200.png) · [320px with doubled text](320-light-text200.png)

[Home status](1440-home-status.png) · [Monitor status](1440-monitor-status.png) · [Phone Login](390-login.png) · [Phone guest access](390-guest.png) · [Recovery surface](390-fallback.png) · [Unavailable storage and sync](390-read-load-failure.png)

The selector passes 16 compositions: 1440/768/390/320px, both device modes, native/doubled text. It measures whole words, icon and edge clearance, shared title/tab/form gutters, dividers below all tabs and native Tab visibility clear of the system bar/dock. Captures retain the real focused scroll position.

Eighteen desktop/phone behavior cases cover selection, preset preservation, save/reload/export/import, manual overrides and subscription cleanup, live Home/Monitor paint, themed notifications, unchanged editor contents, login, guest-local changes and error recovery. Seven storage cases cover denied local reads, writes, both, JavaScript cookie access and failed server sync. No device-only colour change saves a preference; there are no browser errors or unexpected mutations.

Top bars, coloured desktop headers and the dock retain translucent palette glass with 28px blur and no white frame rims or inset chrome sheen. The mode-card grid reflows with text size. Home/Monitor paint uses the existing palette tokens; this is a representative Ocean dynamic check, not a new six-preset contrast matrix.

Negative checks retain the absent mode selector, denied-write Settings crash, intermediate language-detection startup failure and old backend's rejected system preference. Checker corrections explicitly select Files before inspecting its editor and compare actual painted CodeMirror colours rather than a nonexistent class. Storage hooks, routes, cache and viewport restore after the retained run.

Run against the frozen compiled frontend:

```sh
ORBIS_VISUAL_SYSTEM_MODE_ONLY=1 \
  ORBIS_VISUAL_SCREENSHOT_DIR=/tmp/orbis-system-mode/screenshots \
  node scripts/visual-qa.cjs > /tmp/orbis-system-mode.json
```

Published-image confirmation, other browsers and physical devices remain open. Full theme packs are a later product feature.
