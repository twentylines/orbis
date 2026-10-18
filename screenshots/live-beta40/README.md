# Published beta40 checks

The exact digest-pinned arm64 image passes the reviewed beta39→40 update, independent stopped-snapshot verification and the separate 33-entry/17-file app/configuration/data oracle. Both apps, preferences and 28 saved task outcomes survive. A real wrong-password/retry passes and closes only the new login session; the original session and preferences remain.

[Sanitized assertions](assertions.json) · [Desktop Apps](1440x1120-apps-native.png) · [Desktop Store](1440x1120-store-native.png) · [Phone Apps](390x844-apps-native.png) · [Phone Store](390x844-store-native.png) · [Blank phone Login](login-phone.png)

The four native Apps/Store views use published HTML/JS/CSS and real API reads. Each painted card fills its wrapper; individual rows and Store filters share the title/content gutter. All visible icons decode. Top bars and desktop titlebars compute translucent 28px blur with transparent frame borders and no inset sheen. There are no page errors or real preference/app/host writes. Original preferences, installed/full app records and store records match after inspection.

This bounded review uses the saved Dark/Frost mode with browser-only empty window placement and an explicit same-origin connection policy; published document/asset bodies are unchanged. It does not repeat the 48 status/theme compositions or window mutation sequence. The separate [32-case compiled-source Apps/Store matrix](../tile-comfort/README.md) covers light/dark and enlarged text. Copied x86 authenticator adoption is tracked separately in [release notes](https://github.com/twentylines/orbis/releases). Other browsers, physical devices and complete product/migration acceptance remain open. Hades is unchanged.

## Separate copied stock authenticator account

The owned x86 guest now runs the same published beta40 digest from an independently verified copy of the beta39 stock-account adoption. The stopped beta39 snapshot verifies 3,503 entries, 2,771 files and 79,507,050 bytes, and the copy matches bytes, modes, numeric ownership and links before operational paths change. Original stock/beta39 trees are retained. This is a manual copied-image adoption, not a reviewed x86 OTA.

The original account/password/encrypted-secret/salt hash remains exact. Certificate-verified HTTPS API checks authenticate without reenrollment, reject password-only access, returnHTTP400 for wrong/consumed/exhausted challenges andHTTP429 on the fifth wrong attempt, and close only the new session. Actual phone browser login also passes with the original secret, complete translated/themed rejection and empty inputs after retry. Cookies remain Secure/HttpOnly/host-only/SameSite Lax.

[Empty authenticator fields](phone-totp-empty.png) · [Rejected code with empty fields](phone-totp-rejected-empty.png) · [Separate sanitized stock/adoption assertions](../../verification/authentication-stock-totp.json)

These captures contain no password, seed, QR data or entered code. The actual two-host proxy checks also pass for replay, cross-host binding, grant expiry and logout revocation; [the separate assertion record](../../verification/authentication-forward-auth.json) includes cleanup.
