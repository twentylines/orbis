# Host disk and network history

Implementation in progress after beta43. The published beta43 image has current host readings and aggregate CPU/memory/core-network history; it does not yet include this per-device history.

## Source checkpoint

The backend model/service, authenticated query validation and helper generation fields pass 591 backend, 78 common and 126 Python tests. Independent suites exercise 68 model cases, 22 service cases and 50 parser cases, plus 15 Python identity cases. They cover weighted means/peaks, impossible aggregates, retention, name churn/evictions, private real temporary files, two restarts with partial-minute continuity, corrupt/oversized/symlink preservation, timer coalescing, storage backoff and a stalled writer through 361 samples. Model capacity overflow and impossible count/mean acceptance were rejected and corrected. Backend types and bundle pass.

Three additional regressions now distinguish a failed network group, both failed history groups and a filesystem-only failure. The prior implementation hid partial failures and reported healthy collection when both relevant groups failed. The correction retains valid disk/interface history and reports the unavailable groups; filesystem-only failures do not affect device history. Backend types and bundle pass.

The compiled Monitor presentation passes desktop/tablet/phone and doubled-rendered-text checks, device/range selection, delayed responses, empty/error states, keyboard/pointer inspection, hidden polling and refresh/reading-position checks. Direct review rejected a narrow 55px plot despite passing text bounds; the final phone plots use the full 166/236px interior. Cached-data Retry failures in all three host cards now retain the surviving Retry button; a successful retry moves focus to the card heading. [Captures, assertions and source boundaries](screenshots/host-device-history/README.md).

A read-only Linux source probe verifies all 11 actual device identities against independent kernel-derived digests across two samples and a new collector. First/new-collector rates wait for a comparison. A subsequent private, dated helper backup and guarded rehearsal upgrade now verify the installed telemetry module, all 11 identities/rates and matching host/core Unix readings. Environment, unit and every other installed module match the backup. The core remains healthy on its exact published beta43 image; authenticated current-device readings and full preference/app/store records retain the previous verified baseline. Real backend background collection, restart persistence and published device-history API/UI remain separate release gates. Hades is untouched.

## Contract

- Reuse the restricted helper's selected interface/disk rates. Add an opaque generation digest based on the Linux boot and kernel device identity; never expose MAC addresses, boot identifiers or hardware serial numbers. An older helper keeps current readings but explicitly lacks history identity support.
- Record from one coalesced backend collector every ten seconds, independently of browser viewers. Stale, repeated, out-of-order or invalid samples do not become fresh history.
- Keep at most 64 logical interface/disk names. Report capacity eviction rather than silently implying a complete seven-day archive. Rates remain separate by device; layered disks and virtual interfaces are not added into a fake host total.
- Keep ten-second samples for five minutes in memory, minute aggregates for one hour, five-minute aggregates for 24 hours and 30-minute aggregates for seven days. Update tiers from measured samples with weighted means, peaks and actual sample counts. Device changes within an aggregate make that aggregate unavailable; changes between aggregates break the chart line.
- Use a separate private, bounded journal. Append completed buckets and compact retained tiers periodically; do not rewrite the complete archive every sample or modify the existing aggregate history file. Preserve corrupt or inaccessible files and continue in memory with an explicit storage state.
- Serve authenticated, fixed read-only history routes with a bounded device catalogue and at most 720 points for one selected device. Validate range and logical device identifiers; queries are lookups, never filesystem paths.

## Presentation

Use the existing chart material and keyboard/pointer inspection, with practical device-specific labels. Select network or disk and a device without opening dozens of charts. Preserve range and device in the URL, pause hidden browser queries, and retain native focus/reading position during refresh. Show averages, peaks, sample counts, collection/storage state and unavailable history honestly. Keep current host readings usable when history is unavailable.

## Verification before release

1. Independent model/service regressions: tier means/peaks, retention, identity changes, missing values, duplicates, clock changes, limits, restart/partial-minute continuity, storage errors/corruption and private modes.
2. Authentication and query validation, fixed helper identity fields, old-helper compatibility and no extra exposed host metadata.
3. Compiled browser checks at desktop/tablet/phone and doubled text: selector labels, empty/error/retry states, chart geometry/contrast, keyboard inspection, refresh/scroll/focus and hidden polling.
4. Real owned Linux helper identities and rates, history collection with every browser closed, persistence through a planned core restart and exact data preservation. Then publish and verify the immutable image and reviewed arm64 OTA. Hades remains outside development.
