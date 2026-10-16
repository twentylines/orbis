# Orbis progress

## Full requested goal: approximately 55%

Updated 16 October 2026. This is a coarse estimate of the entire requested product, including the later theme packs and multiple homelabs. It is not a measured test score or a production-readiness claim. The requirement-level record is [ACCEPTANCE.md](ACCEPTANCE.md).

| Area | Progress |
| --- | --- |
| Server desktop | Home, editable workspace, app pinning, section motion, expanding search, light/dark, windows and themed notifications are implemented. UI corrections and broader interaction audits continue. |
| App management and monitoring | Existing Runtipi app/store/configuration capabilities are retained. Real disposable app lifecycle, container health/resources, uptime, Usage and aggregate history have been exercised. More host detail and inherited compatibility cases remain. |
| GitHub updates and recovery | Published beta34 passed a reviewed update and fresh password login in the isolated arm64 homelab. Stalled Git refreshes timed out and recovered without losing the verified baseline. See [DEPLOYMENT.md](DEPLOYMENT.md). |
| Real homelab replacement | Copied real-data migration, external storage, remaining authentication/HTTPS cases and final deployment acceptance are still required. Hades has not been replaced. |
| Full theme packs | Basic appearance settings exist. Packs that change every surface and the wider personalisation controls remain to be implemented. |
| Multiple homelabs | Pairing/controller requirements are recorded. Agent installation, secure commands, target-aware installs/launches, merged dashboards and multi-server visualisation remain to be implemented and tested on two isolated hosts. |

## Current work

Window navigation is reserved for large screens. Phones, tablets and short viewports now use ordinary full-page sections with the same dock navigation and section motion. Responsive transitions retain mounted form drafts and saved desktop placement. Settings uses shared gutters and a divider below every tab row; retained checks now compare those relationships directly. These changes are installed on the isolated beta34 stack. Its real window audit also exposed cancelled preference writes: the source now serializes/coalesces saves and passes delayed-response checks; beta35 publication and real-image acceptance are next. [VISUAL-QA.md](VISUAL-QA.md) records the tested cases and limits.

The remaining work is substantial, especially migration and multiple homelabs. A published beta or a passing screenshot matrix does not complete the full goal.
