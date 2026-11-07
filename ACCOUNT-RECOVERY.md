# Local account recovery

Orbis installations based on a Runtipi CLI-v4 tree retain its local CLI. From that installation folder, a server administrator can run:

```sh
sudo ./runtipi-cli reset-password
```

The CLI prompts for a new password and confirmation without echoing either. Recovery replaces the operator password, disables its previous two-factor enrollment and revokes its dashboard sessions. Sign in with the new password and set up two-factor authentication again in Security. Orbis core releases are managed through Update Center and the pinned host tools.

The [upstream CLI](https://github.com/runtipi/cli/blob/develop/internal/commands/reset_password.go) writes a local Unix-second request timestamp and uses its signed CLI authorization. The backend retains that contract: browser sessions, app-host sessions and unauthenticated requests cannot use the reset endpoint. There is no public reset-status or cancellation endpoint.

## Recovery failures

- The backend also enforces the existing eight-character password minimum. Invalid input leaves the request and account unchanged.
- A request must contain a decimal Unix-second timestamp at or before the current time, less than fifteen minutes old. A trailing newline is valid; missing, malformed, expired, millisecond and future timestamps are rejected with HTTP400.
- Overlapping reset attempts in the single backend process return HTTP409. The in-progress flag is released after success or failure so a legitimate retry can proceed.
- A hash/database failure keeps the request for retry. After a successful password update, operator sessions are revoked before request cleanup. Cleanup failure returns an explicit HTTP500 stating that the new password is already active and the server administrator must clear `state/password-change-request`; it cannot report success silently.

This does not make password, database and cache operations one cross-store transaction. A cache/session-revocation failure after a database update remains a partial recovery failure; the local administrator must resolve the fault and retry. Orbis reports that state explicitly and retains the local request. Unreadable SQLite records cannot masquerade as an empty session list, and the session index is kept until its session value has been deleted so retry can still find a failed deletion. The overlap guard covers the current single-process deployment, not multiple independent backend workers.
