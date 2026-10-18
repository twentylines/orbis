# Published beta48 — update accepted, UI audit incomplete

18 October 2026. Immutable source `48089d6797be81947c96cfa13654bb597ef20b6b`, OCI index `sha256:2c06d598df5d288895aed475628dd09b04213a4eda4283e0587c51ca87fb3cef`. Independent manifest/tag/registry checks match both amd64 and arm64. Source CI, integration and release workflows pass; [sanitized report](../../verification/beta48-published.json) records exact identities.

## Reviewed update and data

The actual primary arm64 rehearsal updates from beta46 to beta48 through one browser plan/apply after changelog review. Job `0c126476-da99-4541-ae2d-6406ca1f6d2b` completes at the exact healthy image. Full app/store/preferences/link/user-context records, two app records and all 28 saved task outcomes remain exact. All update browser resources close.

The stopped beta46 snapshot independently rereads 3,597 entries, 2,832 files and 167,862,745 bytes, tree SHA `053e419d203fb7fcd44e6e679f11bf6a2e7b7aa09c693079aa09bb9610ee5ffa`. Protected app/data/store/override trees match. The copied x86 beta40 and recovery beta47 identities/start times/health remain unchanged; persisted Mac Docker default stays `default`. Hades is untouched.

[Actual changelog](changelog.png) · [Reviewed update](review.png)

## First published compact UI attempt — rejected

The planned matrix is 30 authenticated route compositions and four anonymous views. The first run accepts only desktop Home and its Search open/Escape/focus/scroll subcase, then stops on a blank Monitor document after a failed actual JavaScript asset request. The route and expected selector both exist in source. Remaining 29 authenticated and four anonymous views were **not executed**.

Full records and observer session remain unchanged; one group context, reader and browser are closed. The raw primary trace is a timeout waiting for Monitor to render. Geometry cannot be measured on a blank document. This is **unclassified**, not an established layout, transport or verifier defect.

Later independent direct reads return the exact failed JS asset with HTTP200 in 28.76ms, Monitor HTML200 in 3.97ms and health200 in 2.85ms. These later reads do not establish the earlier failure's cause. Two bounded native-browser checks (direct Monitor and Home→Search→Monitor dock) and one original forwarding/full-navigation diagnostic all pass with unchanged records and closed resources. The forwarded case records one expected cancellation of the prior SSE stream on full navigation and no failed asset or forwarding exception. They do not reproduce the original failure. R1 remains unresolved; no product or verifier correction is claimed. The one full rerun with added private exception logging rejects a different refresh problem below; no remaining matrix is accepted.

[First failure capture](1440x1120-text1-FIRST-FAILURE-actual-viewport.png). The accepted desktop Home capture is in this directory; other current compact surfaces remain unaccepted. Source checks separately pass 32 native compositions, four doubled-phone groups and 20 surface samples; do not substitute those for published-image acceptance.

## Boundaries

Actual saved authenticated appearance is Dark/Frost. Source tests separately cover other modes/presets. This release includes the source SQLite failure/retry correction; the normal actual local CLI recovery was exercised on beta47, which excludes that correction. No published SQLite failure injection, copied real-data migration, full theme pack, multi-homelab or physical hardware numerical acceptance is claimed. Raw baselines, observer cookies, private GO proof and diagnostics stay outside Git.

## Second attempt — refresh rejected

Home/Search and Monitor arrival render without JS/read/asset/page errors. On an actual process refresh, the focused CPU button moves308px while retaining its full focus marker. Its content coordinate is unchanged: scroll6218→5910 and viewporttop206.234375→514.234375. The list switches from stale rows to no CPU comparisons. Live scrollHeight/max were not captured, so that run alone cannot prove the scroll-clamp cause. Full records/observer remain exact and all resources close. The blank first attempt remains separate.

A controlled compiled-source fixture independently reproduces end-range clamping:20→0 rows reduces max scroll5592→3393, forcing current scroll3746→3393 and moving the unchanged-coordinate control353px. Other planned source groups stop at that first failure. A narrow source fix retains a clearly labelled previous CPU sample during comparison warmup and keeps Memory current; verification is in progress. This fix is newer than immutable beta48.
