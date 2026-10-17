# Published beta36 checks

These captures use the published beta36 HTML/assets and actual isolated server reads. Window checks perform real preference saves and restore the original account state. Theme compositions shadow only mode/preset/window placement in the browser; no real preference/app/host write is sent. A browser-only same-origin connection policy is labelled in the assertions. All 15 released stylesheets match the source bundle used for the rendered blur proof byte for byte.

- Reviewed beta35→36 OTA reached the exact healthy image; two app records, preferences and28 task outcomes survived.
- Stopped snapshot and the separate application/configuration/data comparison verified.
- Real window sequence passes with17px sampled header padding, zero frame scroll and Home at document top. Eight saves plus restoration complete without cancellations.
- Fresh password login passes, closes only its new session and retains the original session.
- 48 native Home/Monitor compositions pass across six presets, two modes and1440/390px. All actual records match after the run.

[Assertions](assertions.json) · [Blush light](1440x1120-light-blush-monitor-native-viewport.png) · [Blush dark](1440x1120-dark-blush-monitor-native-viewport.png) · [Ocean light](1440x1120-light-ocean-monitor-native-viewport.png) · [Ocean dark](1440x1120-dark-ocean-monitor-native-viewport.png) · [Phone Monitor](390x844-light-frost-monitor-native-viewport.png)

[Released window](monitor.png) · [Floating Settings](floating-settings.png) · [Phone Settings](mobile-light-settings-page.png) · [Fresh login](login-phone.png)

## Finding outside the theme gate

The preserved account has both Applications and System status set wide. Its Home captures reveal unused grid columns and excess launcher minimum height. This needs a layout follow-up; the theme results do not establish that the complete Home layout is accepted. Phone full-card diagnostic clips are omitted because fixed chrome can intersect an off-viewport clip.

These are isolated arm64 Chrome results. Hades is unchanged; production, other browsers and physical-device acceptance remain open.
