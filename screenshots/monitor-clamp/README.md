# CPU comparison warmup — source verification

Compiled source on loopback8080 with controlled data, 18 October 2026. These are synthetic readings and **do not show a repaired published beta48**. [Source fingerprints and summary](../../verification/monitor-clamp-source.json), [negative report](negative-report.json), [accepted report](accepted-report.json).

## Reproduction

An independent fixture focuses the CPU sort control before a 20-row process list, near the scroll range's end, then returns a fresh sample with no CPU comparisons using the existing query timer. The preceding source replaces the rows with an empty state. Max scroll shrinks from 5,592 to 3,393 and forces scrollTop from 3,746 to 3,393, moving the control 353px despite its unchanged content coordinate. The first case rejects; the other two planned groups are not run. This proves the source clamp mechanism. The live beta48 refresh omitted scrollHeight/max, and its earlier blank-page failure remains separate and unexplained.

## Correction and accepted cases

Keep the last valid CPU sample while fresh comparisons are pending. Its original timestamp, values, order and coverage remain explicitly marked as previous/delayed. Memory shows the current sample. New valid CPU readings replace/reorder the retained rows; an initial warmup without history invents no previous data. No artificial blank spacer is added.

All **3/3 groups pass**: 1440×1120 native, 1100×640 native and 320×800 with doubled computed text. Pending-refresh viewport drift is **0px** in every case, with exact raw scroll retention. Fresh CPU recovery drift is 0/0/0.796875px. Exact old CPU/RSS/PID/name/order/time/coverage, current Memory and no-history warmup are checked in every group. No errors, writes, external requests or preference-shadow writes occur; text/routes/listener/viewport restore and browsers close.

| Group | Before | Previous sample during warmup | Fresh CPU recovery |
| --- | --- | --- | --- |
| Desktop | [Before](monitor-clamp-monitor-clamp-1440x1120-text1-before.png) | [Delayed](monitor-clamp-monitor-clamp-1440x1120-text1-after.png) | [Recovered](monitor-clamp-monitor-clamp-1440x1120-text1-recovered-cpu.png) |
| Compact desktop | [Before](monitor-clamp-monitor-clamp-1100x640-text1-before.png) | [Delayed](monitor-clamp-monitor-clamp-1100x640-text1-after.png) | [Recovered](monitor-clamp-monitor-clamp-1100x640-text1-recovered-cpu.png) |
| Phone, doubled text | [Before](monitor-clamp-monitor-clamp-320x800-text2-before.png) | [Delayed](monitor-clamp-monitor-clamp-320x800-text2-after.png) | [Recovered](monitor-clamp-monitor-clamp-320x800-text2-recovered-cpu.png) |

[Current phone Memory](monitor-clamp-monitor-clamp-320x800-text2-current-memory.png) · [Initial warmup](monitor-clamp-monitor-clamp-320x800-text2-initial-warmup.png).

The initial phone warmup capture is a natural partial reading view: heading/control are visible, and Collecting text is checked in the DOM below the viewport. It is not a claim that all enlarged copy fits in one screen. The auditor manually inspected delayed/current/recovered/warmup captures; root also reviewed compact-desktop and doubled-phone delayed states. Labels wrap as whole words, controls/focus remain clear and no pale frame rims appear.

## Compact gutter and existing interaction follow-up

The unchanged older functional check rejects a2px title-gutter mismatch at390px: process62px/Docker64px. Docker's fixed18px container rule now uses the same compact token. Once both match62px, the check's older fixed18px minimum separately rejects the intentional16px compact contract; its minimum now follows the declared token (16px floor,18px legacy fallback), with gutter/whole-word/control-clearance checks retained. Both rejections are saved in this directory.

Final coverage combines16 completed desktop/tablet states from the CSS-final R2 and24 passed phone states in explicit R3:40 state cases,10 retries,10 warmup cases,5 ranking refreshes,5 focused-growth cases and2 polling-suppression cases. The retained16 have their actual padding rechecked against the current desktop/tablet contract. This is a composed matrix, not a single all40 terminal pass. Phone R3 cleans up without errors or mutations. Its helper receives formatter-only wrapping/an optional trailing argument comma afterward; exact reconstruction matches its executed hash. The final3-group clamp run uses the final gutter build and formatted helper.
