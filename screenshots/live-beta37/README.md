# Published beta37 checks

These captures use the exact published beta37 image and actual isolated server reads. Only mode/preset/window placement is shadowed in the theme run; the saved workspace, app records and telemetry remain real. A browser-only same-origin connection policy is labelled in the assertions. No CSS or published asset body is replaced.

- Reviewed beta36→37 OTA reached the exact healthy image, retaining both app records, preferences and all 28 saved task outcomes.
- The stopped snapshot and separate 33-entry/17-file application/configuration/data comparison verified.
- All 48 native Home/Monitor compositions pass across six presets, light/dark and 1440/390px, with no browser errors or real preference/app/host mutations. Original records match.
- All 24 Home compositions now measure filled custom row edges and zero forced independent launcher height. The saved arrangement with both upper cards wide is retained.
- Fresh password login passes and closes only its new session; the original session and preferences survive.

[Assertions](assertions.json) · [Home light](1440x1120-light-frost-home-native-viewport.png) · [Home dark](1440x1120-dark-frost-home-native-viewport.png) · [Blush light](1440x1120-light-blush-monitor-native-viewport.png) · [Blush dark](1440x1120-dark-blush-monitor-native-viewport.png) · [Ocean light](1440x1120-light-ocean-monitor-native-viewport.png) · [Ocean dark](1440x1120-dark-ocean-monitor-native-viewport.png) · [Phone light](390x844-light-frost-monitor-native-viewport.png) · [Phone dark](390x844-dark-blush-monitor-native-viewport.png) · [Login](login-phone.png)

Root inspected the released Home and Monitor captures. These are native viewport captures at their natural route top, so content below the viewport is intentionally scrollable. Off-viewport full-card diagnostic clips are not presented as phone viewport compositions. The source-only 112-case matrix separately covers doubled text and other widget/app-count arrangements. Window navigation styles remain the beta36 code whose actual window flow passed; that mutation sequence was not repeated for this Home/dependency iteration.

These are isolated arm64 Chrome results. Other browsers, physical devices, copied real-data migration and full production acceptance remain open. Hades is unchanged.
