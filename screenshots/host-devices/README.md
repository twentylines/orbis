# Host device source checks

These captures use the compiled local source at static8080 with controlled API responses. They do not show a newly installed release or a production host. The installed arm64 test core remains beta41, the separate copied x86 authenticator fixture remains beta40, and Hades is unchanged.

## Host counter proof

[Linux source assertions](linux-source-proof.json) come from the actual new Unix handler in the owned arm64 Linux guest. The probe returns 11 mounted filesystems, eight interfaces and three whole devices. Root capacity matches host `statvfs`; the first sample has no invented rates, and a second real sample produces network and disk rates. Temporary container mounts and arbitrary query paths are rejected. The temporary server closes. The proof records both source hashes and does not change the installed helper or core.

## Layout, refresh and focus

[Layout/state assertions](assertions.json) cover 16 ready compositions at 1440/768/390/320px, both modes and native/doubled text, plus 35 first-sample/stale/partial/omitted/empty/unavailable/error states. Measurements compare section gutters, card padding, whole words, identifier ellipsis, value columns and numeric units. Five Collecting polls resolve after about two seconds; five real ten-second refreshes preserve exact scroll. Rapid native forward/reverse focus, pending/rejected Retry and successful removed-opener focus all pass. Necessary heading reveals match the padded minimum within one pixel (maximum rounding difference 0.328px), without changing the heading's document position. A deliberately moved focus stays on the user's chosen control.

The assertion index points to [layout measurements](layout-measurements.json) and [state measurements](state-measurements.json). Palette labels reference shared paint records to retain all ancestor/compositing measurements without repeating them. Reconstructing these records reproduces the complete original reports exactly.

[Desktop ready](desktop-ocean-light-ready.png) · [Tablet doubled Retry](tablet-text2-retry.png) · [Phone doubled mount](phone-light-text2-mount.png) · [Phone doubled network](phone-dark-text2-network.png) · [Phone doubled disk activity](phone-dark-text2-disks.png)

The system bar, coloured desktop titlebar and dock retain the same 28px blur and 1.45 saturation. Their colours remain translucent; frame borders/backgrounds are transparent and have no inset pale sheen. Phones/tablets retain ordinary page navigation. All final runs have zero browser errors, unexpected mutations, preference-shadow writes or cleanup failures. Routes, text, viewport and listeners are restored, and the independent auditor confirms its browsers are closed. [Frozen product source hashes](source-provenance.json) identify the tested candidate.

## Presets and chart inspection

[Palette assertions](palette-assertions.json) cover all six presets in both modes, including stale/partial/omitted host readings, resting chart axes and timestamps. Muted host labels are at least 5.944:1; chart axes and time labels are at least 6.197:1. The overall minimum is 4.899:1 for warning text. Ratios account for the actual ancestor colours and both black/white bounds behind translucent surfaces. All expected theme tokens match.

[Frost light](desktop-frost-light.png) · [Stone light](desktop-stone-light.png) · [Ocean dark](desktop-ocean-dark.png)

[Chart assertions](chart-assertions.json) cover CPU/memory at 768/320px with native/doubled text, plus empty and missing-value cases. Axis ink has 12px clearance from the SVG; inspection follows the plot with a 12px gap and reserves its full height. Subsequent content has 20px clearance. Native Left/Right/Home/End update the selected sample and its accessible description. Empty/missing history draws no data segment, and Unavailable remains regular-sized readable text.

[Doubled phone plot](chart-phone-text2-plot.png) · [Flowing details](chart-phone-text2-details.png) · [Empty history](chart-phone-text2-empty.png) · [Missing value](chart-phone-text2-null.png)

Root and an independent agent reviewed the representative palette and chart captures directly. Palette/chart runs report no browser errors, unexpected mutations or cleanup failures, and restore their routes, text, viewport and listeners.

## Defects rejected during inspection

Earlier source candidates split ordinary directory words, lost focus after Retry disappeared, and let inherited smooth scrolling move Retry behind the dock after rapid native Tab. The retained checks now reject these behaviours. A manual Retry may make the minimum padded scroll adjustment needed to reveal its surviving heading; automatic refresh must preserve its exact reading position.

The adjacent chart audit rejected fixed 35/44px axis slots and an absolute inspection popup: doubled labels overlapped the graph, and a phone popup extended about 189px over the following core rows. The corrected chart sizes its axis intrinsically and puts inspection in normal flow. The first palette candidate also failed the 4.5:1 small-text gate in Frost and Stone light. The corrected candidate uses the stronger theme-aware text token, including inherited paragraph overrides.

## Reproduce

Use the existing static8080 preview of a locally built frontend. These opt-in runners are restricted to isolated localhost fixtures and never use the installed server's authentication or data:

```sh
ORBIS_VISUAL_HOST_DEVICES_ONLY=1 node scripts/visual-qa.cjs
ORBIS_VISUAL_HOST_DEVICES_COLORS_ONLY=1 node scripts/visual-qa.cjs
ORBIS_VISUAL_HOST_DEVICES_CHARTS_ONLY=1 node scripts/visual-qa.cjs
```

Set `ORBIS_VISUAL_SCREENSHOT_DIR` to a separate output directory. The Linux probe requires its explicit owned-guest flag and a fresh `/tmp` output path; see [the probe](../../scripts/live-host-telemetry-qa.py).

Published-image/helper upgrade, broader history/sensors/processes, other browser engines, physical devices and complete migration acceptance remain separate gates.
