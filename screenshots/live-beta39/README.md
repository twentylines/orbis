# Published beta39 update and login

The exact published arm64 image passes a reviewed beta38→39 update, stopped-snapshot verification, the separate 33-entry/17-file application/configuration/data comparison and a real wrong-password/retry. Both app records, preferences and 28 task outcomes survive. Only the new login session is closed; the original session and preferences remain.

[Sanitized assertions](assertions.json) · [Blank phone Login](login-phone.png)

Frontend source is unchanged from beta38, so the bounded native gallery and its known tile/filter findings remain explicit in [that review](../live-beta38/README.md). This run does not repeat theme/window mutations or establish copied TOTP/HTTPS/forward-auth adoption. The separate x86 enrollment/adoption work and new HTTP error classification are recorded in `AUTHENTICATION-QA.md`. Hades is unchanged.
