# Local account recovery

On a release that includes the Orbis CLI, a server administrator can reset the operator password from an interactive terminal on the Docker host:

```sh
sudo docker exec -it runtipi orbis-cli reset-password
```

In the standard installation, the Core container keeps its compatibility name `runtipi`. If the host uses a different container name or Docker context, use the name and context of the running Orbis Core. The CLI prompts for the new password and confirmation without echoing either.

Recovery replaces the operator password, disables its previous two-factor enrollment, clears its registered passkeys and revokes its dashboard sessions. Sign in with the new password and set up your sign-in methods again in Security. If the CLI cannot confirm the result, check whether the new password works before retrying.

The Orbis CLI runs inside Core. It uses the existing private CLI key, a local Unix-second request timestamp and a signed request to Orbis on the container's loopback address. Browser sessions, app-host sessions and unauthenticated requests cannot use the reset endpoint.

On an older Orbis release migrated from Runtipi CLI v4, the retained [upstream CLI](https://github.com/runtipi/cli/blob/develop/internal/commands/reset_password.go) also supports recovery. From that installation folder, run:

```sh
sudo ./runtipi-cli reset-password
```

## Recovery failures

- The backend also enforces the existing eight-character password minimum. Invalid input leaves the request and account unchanged.
- A request must contain a decimal Unix-second timestamp at or before the current time, less than fifteen minutes old. A trailing newline is valid; missing, malformed, expired, millisecond and future timestamps are rejected with HTTP400.
- Overlapping reset attempts in the single backend process return HTTP409. The in-progress flag is released after success or failure so a legitimate retry can proceed.
- A hash/database failure keeps the request for retry. After a successful password update, operator sessions are revoked before request cleanup. Cleanup failure returns an explicit HTTP500 stating that the new password is already active and the server administrator must clear `state/password-change-request`; it cannot report success silently.

This does not make password, database and cache operations one cross-store transaction. A cache/session-revocation failure after a database update remains a partial recovery failure; the local administrator must resolve the fault and retry. Orbis reports that state explicitly and retains the local request. Unreadable SQLite records cannot masquerade as an empty session list, and the session index is kept until its session value has been deleted so retry can still find a failed deletion. The overlap guard covers the current single-process deployment, not multiple independent backend workers.
