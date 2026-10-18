# Published beta42 checks

The exact digest-pinned arm64 release passes a reviewed beta41→42 update. Both app records, preferences and all 28 saved task outcomes remain intact. The installed helper was upgraded separately after a private dated backup; the service is active, installed source hashes match, environment/unit bytes are unchanged and actual host/core Unix readings agree.

[Release, OTA and data assertions](release-and-data-assertions.json) · [Installed-helper assertions](../host-devices/installed-helper-proof.json) · [Compiled-source layout and palette checks](../host-devices/README.md)

## Actual update and preservation

Release workflow `39093163805` publishes source `9adb1d18f78e207f1b88d680059ed46e272e6820` for linux/amd64 and linux/arm64. The independently checked index is `sha256:3a0435e87402e3dd74c8d3ea2fff06cc2cf3e74d0a85dfbd4dfdfa35e02eac0f`. The actual browser reviews and submits update job `df94681f-2231-44e5-bc2f-fdf6e696f3af`, which reaches that exact healthy image without page errors.

The stopped beta41 snapshot independently verifies 3,591 entries, 2,827 files and 149,837,205 bytes, tree hash `e28d076dadb723a93b5ba84d4dcb9a9f996e5fc88a48c33558bfa81c6d403d81`. Its protected directory is root-owned `0700`. Snapshot fingerprints for apps, app data, user configuration and repositories match the current trees. The separate original application/configuration/data comparison matches all 33 entries and 17 files, hash `7f4c0a000362ee45d1cca9c2e9b9c8a5f65dc0c9478444c04b1090dd542456d2`.

The Mac explicitly uses `colima-runtipi-test`; `default` in the snapshot record is the isolated guest's context. Ownership-sensitive protected-file comparisons run on the Mac, where their baseline was captured; the guest's shared-filesystem UID/GID mapping is different. The Mac's default Docker context is unchanged. No permissions were changed to reconcile those namespaces.

## Published Monitor review

The separate read-only published-image audit passes native 1440/768/390/320px and 320px with doubled computed text, using actual HTML, scripts, styles, images and API bodies. All five layouts render the actual 11 filesystem, eight interface and three disk identifiers in order. Authenticated telemetry returns 200; a separate unauthenticated request returns 401. A fresh sample becomes available after a bounded 10.074-second warmup, without invented readings.

Five subsequent distinct refreshes arrive after 10,014–10,040ms and preserve exact reading positions. Whole words, accessible identifier ellipsis, card spacing, shared gutters and native heading/chart focus pass. The top bar, coloured desktop titlebar and dock retain their shared translucent palette blur, transparent outer frame and no inset white sheen. Root directly inspected representative desktop, tablet, native phone and doubled phone captures.

All 110 forwarded browser API reads and 90 fingerprinted published assets succeed. No response body or preference is substituted. There are no real or attempted writes, browser errors, read/asset failures or cleanup failures. Full app/store/preference records match. All five group contexts, reader, anonymous context and browser close. The only controlled browser changes are one doubled-computed-text group and a restrictive same-origin CSP header. Screenshots retain actual wheel/focus reading positions; they are not reset for composition.

[Browser assertions](assertions.json) reference five per-group measurement files, each below the formatter's size limit. Reconstructing those references reproduces the complete original report exactly. All twenty actual captures are retained.

[Desktop chrome](1440x1120-text1-initial-actual-viewport.png) · [Desktop host readings](1440x1120-text1-heading-actual-viewport.png) · [Desktop interfaces](1440x1120-text1-network-actual-viewport.png) · [Desktop disk activity](1440x1120-text1-disks-actual-viewport.png)

[Tablet interfaces](768x1024-text1-network-actual-viewport.png) · [Phone host readings](390x844-text1-heading-actual-viewport.png) · [Phone interfaces](390x844-text1-network-actual-viewport.png) · [Phone disk activity](390x844-text1-disks-actual-viewport.png)

[320px Monitor](320x800-text1-initial-actual-viewport.png) · [Doubled host text](320x800-text2-heading-actual-viewport.png) · [Doubled interface text](320x800-text2-network-actual-viewport.png) · [Doubled disk text](320x800-text2-disks-actual-viewport.png)

This is the actual saved Dark/Frost appearance. The separate compiled-source matrix covers six presets in both modes; this read-only audit does not change preferences merely to repeat that matrix. It also does not replace the source missing/partial/stale/empty/error and pending-Retry checks.

## Scope

These are isolated synthetic arm64 checks. Authentication code is unchanged and the original session remains valid, so beta42 does not repeat the beta41 password rejection/retry. The separate copied x86 authenticator fixture stays on beta40. Other browser engines, physical devices, host processes/sensors, richer history and complete product/migration acceptance remain open. Hades is unchanged.
