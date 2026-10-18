# Copied stock authenticator account

Actual published beta39, Chrome at 390×844, against the separate x86 copy of an official Runtipi account. HTTPS browser trust is restricted to the fixture public key; certificate and hostname validation pass separately at the API transport. No production account or Hades data is used.

[Empty challenge](phone-totp-empty.png) · [Rejected code and retry](phone-totp-rejected-empty.png) · [Sanitized assertions](../../verification/authentication-stock-totp.json)

The retained password and authenticator secret authenticate without reenrollment. Password alone remains signed out, a wrong code shows the translated themed error and clears the inputs, and the valid retained code reaches the dashboard. Only the new session is closed. These captures contain no password, seed, QR data or entered code.

**Beta39 HTTP classification remains rejected:** an incorrect code returns HTTP500. The source fix returns HTTP400 while preserving HTTP429 on the fifth invalid attempt; published-image confirmation is still required. This gallery does not establish actual app-host forward authentication, public certificate issuance or real homelab migration.
