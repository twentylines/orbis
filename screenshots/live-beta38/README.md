# Published beta38 checks

The exact published image passes the reviewed beta37→38 update, stopped snapshot verification, the separate 33-entry/17-file application/configuration/data comparison, and a real rejected-password/retry flow. A wrong password stays signed out with translated themed feedback and retained, enabled fields; the valid retry authenticates. Only its new session is closed. Original session and preferences survive. The login capture contains blank fields only.

The bounded native audit covers eight actual routes at 1440×1120 and 390×844: Home, Apps, Store, Monitor, Updates, Settings overview, Appearance and an installed-app overview. Actual API reads return 200, visible images load, and preferences, two installed/full app records and two stores match afterward. There are no page errors or forwarded mutations. Appearance/window responses are shadowed only in the browser. Published document/JS/CSS bodies remain unchanged.

The titlebar, topbar and dock have translucent palette surfaces and `blur(28px) saturate(1.45)`. The desktop frame is transparent, without the white rim or inset highlight. All 15 prior shared CSS bodies are byte-identical to beta37; nine additional route styles were loaded without that prior reference. The 48-preset/mode/viewport compositions and optical blur probe were not repeated for this dependency-only release.

**Manual review found two remaining visual defects:** character-count limits crop tile text mid-word, and Store filters sit 12px inside the shared title/card gutter. These captures preserve that evidence; this is not an all-UI acceptance claim. Source corrections are being checked separately.

[Assertions](assertions.json) · [Home](1440x1120-home-native.png) · [Monitor](1440x1120-monitor-native.png) · [Store before correction](1440x1120-store-native.png) · [Appearance](1440x1120-appearance-native.png) · [Phone Home](390x844-home-native.png) · [Phone Monitor](390x844-monitor-native.png) · [Phone Store before correction](390x844-store-native.png) · [Phone Appearance](390x844-appearance-native.png) · [Blank Login](login-phone.png)

These are isolated synthetic-data Chrome results. Copied real-data adoption, external storage, other browsers/devices and complete production acceptance remain open. Hades is unchanged.
