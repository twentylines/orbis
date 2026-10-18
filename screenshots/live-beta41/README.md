# Published beta41 checks

The digest-pinned arm64 release passes a reviewed beta40→41 update, independent stopped-snapshot verification and the separate app/configuration/data comparison. Both installed apps, preferences and 28 task outcomes survive. Wrong-password feedback and the successful retry pass; only the new login session is closed.

[Sanitized assertions](assertions.json) · [Light Home](1440x1120-text1-home-light-actual-viewport.png) · [Dark Home](1440x1120-text1-home-dark-actual-viewport.png) · [Light Monitor](1440x1120-text1-monitor-light-actual-viewport.png) · [Dark Monitor](1440x1120-text1-monitor-dark-actual-viewport.png)

[Light Appearance](1440x1120-text1-appearance-light-actual-viewport.png) · [Dark Appearance](1440x1120-text1-appearance-dark-actual-viewport.png) · [Phone Home](390x844-text1-home-light-actual-viewport.png) · [Phone Monitor](390x844-text1-monitor-dark-actual-viewport.png) · [Phone Appearance](390x844-text1-appearance-dark-actual-viewport.png) · [Blank phone Login](login-phone.png)

[320px doubled text, light](320x800-text2-appearance-light-actual-viewport.png) · [320px doubled text, dark](320x800-text2-appearance-dark-actual-viewport.png) · [Unavailable browser storage, light](390x844-text1-storage-denied-appearance-light-actual-viewport.png) · [Unavailable browser storage, dark](390x844-text1-storage-denied-appearance-dark-actual-viewport.png)

## Actual preference persistence and rendering

System/Ocean was saved through the authenticated same-origin API. The API and stored file retain the raw `system` choice. One planned restart of the same pinned core preserves the exact stored bytes and original authenticated session. After inspection, the original Dark/Frost preference file is restored byte for byte, including permissions and ownership. The separate 33-entry/17-file application/configuration/data comparison still matches.

The browser audit uses actual published HTML, JavaScript, CSS, images and API reads, without response-body substitutions or preference shadows. Eight groups cover Home, Monitor and Appearance at 1440/390px, 320px Appearance with doubled computed text, and a fresh phone boot with JavaScript localStorage/cookie access denied. Each group follows light→dark→light OS changes: 24 resolved states and 16 viewport captures. HTTP authentication cookies remain intact in the denial case.

All 104 actual API reads succeed and 116 distinct published assets are fingerprinted. Device-mode changes cause no real writes. Preferences, app and store records remain exact. All four browser contexts and the browser close without cleanup errors. Source fixtures separately cover the broader [16-layout, 18-interaction and seven-storage-failure matrix](../system-mode/README.md).

## Chrome, spacing and inspection boundary

The top bar, coloured desktop titlebars and dock use translucent palette colours and the same 28px backdrop blur. Frame borders are transparent, the desktop frame beneath the titlebar is transparent, and chrome has no inset white sheen. Actual Home/Monitor gradients and small-label ink change with the resolved mode. Whole words, interior clearance, shared gutters and native keyboard focus pass the retained checks.

Root and an independent agent reviewed ten representative captures. No new text, spacing, focus or chrome defect was found in that bounded review. The clearly labelled browser-only QA notification temporarily overlays desktop titlebar controls; its copy/dismiss spacing and clearance from the system bar remain intact. It is removed after the check. The audit also adds a restrictive same-origin connection policy to the browser document; published response bodies are unchanged.

This representative Ocean run does not repeat all six presets, every source layout, manual mode edits, export/import or signed-out mode transitions. The separate copied x86 authenticator fixture remains on beta40. Other browser engines, physical devices and complete product/migration acceptance remain open. Hades is unchanged.
