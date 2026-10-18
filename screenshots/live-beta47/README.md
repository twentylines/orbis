# Published beta47 recovery

Actual separate synthetic arm64 Colima installation, 18 October 2026. Exact source `48ffa3454aff42028c1a7cc80fb1d4ce9901e320`, image index `sha256:2c0fb73b40a17af4377b0f147e55f2d2fbeb6f966a99cb4ea29b6ed23a1bd8db`. The saved appearance is **Light/Frost** over loopback HTTP. These captures do not contain the newer compact-screen source or SQLite fault correction.

## Actual checks

- Canonical adoption preserves the original SQL account, encrypted TOTP, saved link/stores and protected trees. Independently reread stopped snapshot: 3,535 entries, 2,803 files, 99,123,979 bytes.
- Original password and retained original authenticator seed work before reset. Actual retained CLI-v4.10.1 rejects a short password, then completes hidden new-password/confirmation prompts. Terminal echo is checked before each input. CLI exit0 alone is insufficient.
- Anonymous/browser reset requests return 401 while the CLI request is active. After reset, three unexpired old dashboard cookies return 401 on protected reads; old password and pending old-seed challenge return 400; the new password authenticates without TOTP.
- Four browser groups pass: 1440px, 390px, 320px and 320px with doubled computed text. Each performs one actual rejected old login, one successful new login and logout only of its own fresh session.
- 112 actual API reads and112 unique published assets succeed. Zero page/read/asset failures, unapproved writes or external requests. Full records and observer session match; core/Traefik identity, image, start, networks and ports match. Four contexts, reader and browser close.

Full source/runtime boundaries and fingerprints: [sanitized acceptance](../../verification/account-recovery-beta47.json), [workflow](../../ACCOUNT-RECOVERY.md).

## Captures

| Size | Login | Local command | New-password dashboard |
| --- | --- | --- | --- |
| 1440 native |[Login](1440x1120-text1-empty-login-actual-viewport.png)|[Command](1440x1120-text1-forgot-password-command-actual-viewport.png)|[Home](1440x1120-text1-replacement-password-dashboard-actual-viewport.png)|
| 390 native |[Login](390x844-text1-empty-login-actual-viewport.png)|[Command](390x844-text1-forgot-password-command-actual-viewport.png)|[Home](390x844-text1-replacement-password-dashboard-actual-viewport.png)|
| 320 native |[Login](320x800-text1-empty-login-actual-viewport.png)|[Command](320x800-text1-forgot-password-command-actual-viewport.png)|[Home](320x800-text1-replacement-password-dashboard-actual-viewport.png)|
| 320 doubled text |[Login](320x800-text2-empty-login-actual-viewport.png)|[Command](320x800-text2-forgot-password-command-actual-viewport.png)|[Home](320x800-text2-replacement-password-dashboard-actual-viewport.png)|

Native field/body gutters are 20px on phones / 40px desktop. Focus markers retain their full 6px extent; toolbar control centres match. The full technical CLI command wraps at its space into two readable lines at 320 doubled. Ordinary copy has no fractured words or painted overflow in the checked states. Root also inspected the 320 native Login and doubled command captures.

## Limits and retained rejections

This fixture has **zero installed apps**; it does not establish installed-app migration, copied real-data acceptance, HTTPS, other browsers/devices or physical hardware readings. Only password/TOTP fields change during reset; the later intentional Welcome acknowledgement is separately checked. The primary beta46 and x86 beta40 fixtures remain unchanged. Hades is untouched.

The first browser attempt stops before any browser or authentication POST: its verifier incorrectly expected two stock Compose files. Canonical adoption uses the exact ordered three-file configuration including `orbis-compose.yml`. The corrected guard retains all root/context/image/network/bind restrictions and passes positive/negative self-checks.

Private rejection captures clear both credentials after checking actual translated feedback and retained fields. That privacy action induces an additional empty-email validation line at 320 doubled; those captures are excluded from this gallery and must not be labelled an original backend recovery failure. Raw reports, credentials, cookies, TOTP seed and PTY transcripts stay private outside Git. A root self-check invocation initially used an unsupported environment flag and rejected before configuration/browser/authentication; the correct `--self-check` invocation passes.
