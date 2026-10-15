# Beta 28 released-image captures

Source: `546005bac38772cd67ed6dd3a548a023b0fa5ae8`

Image: `ghcr.io/twentylines/orbis@sha256:05e486cdde33a4f9aedfb9572487c541827e5622e0be292b13721867279dcaa4`

Captured on the owned isolated arm64 server after the real beta 25→28 browser OTA. Home, Settings, Monitor, saved window placement and authentication-page reads use real APIs. Error recovery and two-factor challenges use explicitly controlled responses; no real account two-factor settings are changed. Enlarged Home doubles computed text and explicit pixel line heights, preserving viewport size and icons; the separate code capture doubles only digits.

The UI and window audits restore account preferences and compare them with the originals. Deployment, snapshot and evidence limits are in [DEPLOYMENT.md](../../DEPLOYMENT.md). Hades was not accessed.
