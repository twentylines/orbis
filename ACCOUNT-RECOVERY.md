# Local account recovery

The current supported development installation starts from a Runtipi CLI-v4 tree and retains its local CLI. From that installation folder, a server administrator can run:

```sh
sudo ./runtipi-cli reset-password
```

The CLI prompts for a new password and confirmation without echoing either. Recovery replaces the operator password, disables its previous two-factor enrollment and revokes its dashboard sessions. Sign in with the new password and set up two-factor authentication again in Security. Orbis core releases are managed through Update Center and the pinned host tools.

The [upstream CLI](https://github.com/runtipi/cli/blob/develop/internal/commands/reset_password.go) writes a local Unix-second request timestamp and uses its signed CLI authorization. The backend retains that contract: browser sessions, app-host sessions and unauthenticated requests cannot use the reset endpoint. There is no public reset-status or cancellation endpoint.

## Current source correction

- The backend also enforces the existing eight-character password minimum. Invalid input leaves the request and account unchanged.
- A request must contain a decimal Unix-second timestamp at or before the current time, less than fifteen minutes old. A trailing newline is valid; missing, malformed, expired, millisecond and future timestamps are rejected with HTTP400.
- Overlapping reset attempts in the single backend process return HTTP409. The in-progress flag is released after success or failure so a legitimate retry can proceed.
- A hash/database failure keeps the request for retry. After a successful password update, operator sessions are revoked before request cleanup. Cleanup failure returns an explicit HTTP500 stating that the new password is already active and the server administrator must clear `state/password-change-request`; it cannot report success silently.

This does not make password, database and cache operations one cross-store transaction. A cache/session-revocation failure after a database update remains a partial recovery failure; the local administrator must resolve the fault and retry. Current source reports that state explicitly and retains the local request. Unreadable SQLite records cannot masquerade as an empty session list, and the session index is kept until its session value has been deleted so retry can still find a failed deletion. The overlap guard covers the current single-process deployment, not multiple independent backend workers.

## Verification

The preceding service fails 18 of 22 initial recovery checks and a separate parallel-reset regression. The corrected source passes all 23 recovery cases, 67 authentication tests, 647 backend tests across 53 files, seven runtime-packaging checks, backend types/bundle and changed-file lint. Temporary files and native Argon2 are real; repository/session dependencies are mocked. [Source evidence and log fingerprints](verification/account-recovery-source.json) keep that boundary explicit.

The next fault-handling correction is separately reproduced with a real temporary SQLite connection, malformed cache records and a DELETE-failure trigger. The preceding cache behavior fails six of31 checks; the index-first deletion order fails its additional regression. Accepted source passes25 recovery cases,69 authentication tests plus7 cache cases,656 backend tests across54 files,7 runtime-packaging checks, types, bundle and strict changed-file lint. Actual request files, SQLite, session manager and Argon2 are used; the user repository remains mocked. [Fault evidence](verification/account-recovery-cache-source.json) retains log/source fingerprints and the retry/preservation boundary. This correction is not in immutable beta47.

## Published beta47 acceptance

A separate synthetic arm64 installation was bootstrapped with the actual official CLI-v4.10.1, then adopted using the exact beta47 digest. Its independently reread stopped snapshot contains3,535 entries/2,803 files/99,123,979 bytes. The original SQL account, encrypted TOTP and protected app/data/store/override trees survive adoption; the retained original password and authenticator seed authenticate before recovery.

The actual retained CLI rejects a short password without changing the account. It then completes a valid reset with terminal echo disabled before both hidden prompts. CLI exit0 alone is not the oracle: the test also checks its success marker, SQL changes, deleted request and actual authentication. Anonymous and browser reset requests both return401 while the CLI request is active.

After reset, three unexpired old dashboard sessions cannot access protected APIs; the old password and pending old-seed TOTP challenge fail. The new password signs in without TOTP. Only password/TOTP fields change; identity, salt, the saved link, store records and protected files remain exact. A subsequent intentional Welcome acknowledgement changes only that additional field. This fixture has zero installed apps and cannot establish installed-app migration preservation.

The actual browser flow passes4/4 groups: desktop1440px, phones390/320px and320px with doubled computed text. Each rejects the old password, signs in using the new password and logs out only its own new session. All112 API reads and112 published assets succeed, full records/observer remain unchanged and all browser resources close. The actual saved appearance is Light/Frost over loopback HTTP, not both modes, TLS or the newer compact source. [Released captures and limits](screenshots/live-beta47/README.md) · [Sanitized acceptance](verification/account-recovery-beta47.json).

The primary arm64 beta46 rehearsal and copied x86 beta40 account remain unchanged. Hades remains reserved for the later approved deployment phase.
