# Regenerated client checks

These source-fixture checks follow the generator and translation-loader upgrade. They use compiled assets and intercepted APIs at localhost:8080; they do not establish released-image or production acceptance.

- Frozen Bun 1.3.0 install, frontend types and bundle pass.
- Nine security/transport tests pass: 42 assertions, no network requests.
- All 81 SDK exports/routes remain present; repeating generation produces identical 17 files.
- Native route checks pass at 1440/768/390/320px: 108 captures, 312 required positive flags true, 36 expected overflow/background-gap flags false, no browser errors.
- A separate 390px anonymous Login check loads translated labels through the actual requested translation path and displays labelled blank fields and actions. No credentials are entered or submitted.

[Assertions](assertions.json) · [Login](mobile-login.png) · [Store](desktop-store.png)

Representative Store, app detail, Appearance and Login captures were manually inspected. Full route images remain in the local run; the current general galleries show the same unchanged layout styles. Published-image verification is recorded separately in DEPLOYMENT.md.
