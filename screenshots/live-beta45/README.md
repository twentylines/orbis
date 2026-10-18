# Published beta45 runtime verification

These are actual readings from the owned isolated Linux arm64 rehearsal at the immutable beta45 image. Hades was not accessed. Published browser acceptance remains open after a refresh/reading-position rejection; this runtime pass does not establish that UI gate.

| Gate | Result and evidence |
| --- | --- |
| Autonomous collection | 130.006 seconds without browser viewers or probe reads; available persistent collection, nine distinct samples at observed 10–20-second intervals, 11 independently calculated device-minute rows and 257 saved summaries. [Complete report](background-history/report.json) |
| Stopped witness | Exact private journal captured while the same core container was stopped. [Report](stopped-history/report.json) |
| Restart continuity | Same container/image, healthy new start; 11 partial-device rows retained, 50 next-minute raw rows, 362/81/26 saved tier rows and 443 summaries compared without double counting. Same-minute merging was not exercised by this restart. [Report](restart-history/report.json) · [Lifecycle proof](restart-control-proof.json) |
| OTA and data | Reviewed beta44→45 update reaches the exact image. Prior full app/store/preferences match; independent stopped snapshot and protected trees match. [Snapshot](stopped-snapshot-proof.json) · [Record comparison](prior-records-proof.json) |

All 11 current device-generation digests match independent kernel readings. Anonymous/authenticated history reads return 401/200; eight invalid/repeated-query cases return 400. Numeric readings, timestamps, counts, means, peaks, source digests and assertions are retained. Device names are deterministic pseudonyms; container IDs are hashes. Full account baselines, credentials and raw execution reports remain private.

[Provenance](runtime-provenance.json) records private execution-report hashes, sanitized parsed hashes and the exact guarded runtime verifier. Split JSON restores recursively: concatenate `$orbis_array_parts` and merge `$orbis_object_parts`. Every complete parsed report is reconstructed and compared before retention. The Mac explicitly uses `colima-runtipi-test`; `default` in a snapshot belongs to the isolated guest. No Hades deployment, physical-device UI or complete product acceptance is implied.
