# Orbis host service preview

The browser can now request a reviewed Orbis core update through an authenticated API and a separate host process. The host process listens on a Unix socket only. It accepts four fixed operations: read status, plan a published release, apply one short-lived plan, and recover one interrupted transaction. It has no shell endpoint or host package update action.

This is currently a **disposable-host test path**. It has unit and socket transport tests and completed a published beta 7 → beta 8 update through the Linux VM's native socket. The Update Center read back the completed job in Chrome. The apply action was sent directly to the socket; a full browser-clicked update still needs rehearsal. Do not attach it to Hades or another production installation. See [DEPLOYMENT.md](DEPLOYMENT.md) for the transaction evidence and limits.

## Boundaries

- The host service uses the explicit installation root and Docker context supplied at startup. A browser request can contain only a release tag or a server-issued plan/job ID.
- A plan verifies the GitHub tag, release manifest, GHCR index digest and supported platforms, existing enrollment, healthy running image, Compose delta, stopped managed apps, and snapshot capacity. Plans expire after 15 minutes.
- Apply rechecks those conditions, pulls before downtime, captures a stopped-state snapshot, starts the digest-pinned release, and uses the existing automatic rollback transaction. The host service keeps running while the Orbis container restarts. A job record is saved outside the installation.
- The backend routes require an authenticated operator session. The inherited `AuthGuard` checks same-origin POST requests; a second guard rejects non-operators and CLI tokens. Only the Orbis backend should receive the Unix socket mount; keep the socket directory and service state private.
- External app mounts, named volumes, and real homelab data still require a copied-data rehearsal and independent backup. The existing updater leaves managed apps stopped. The stock Runtipi CLI `start` and `update` commands are incompatible with an adopted Orbis installation.

## Isolated Linux setup used for beta 8

Use a disposable Linux host with its own Docker daemon and an already enrolled Orbis CLI v4.10.1 copy. Choose actual absolute paths for `ROOT` and `SOURCE` on that host. The host process needs Python 3, Docker Compose, `rsync`, and access to the Docker daemon. The source revision must contain `scripts/orbis-host-service.py` and its sibling host transaction scripts.

```sh
sudo install -d -m 0700 /run/orbis /var/lib/orbis/state /var/lib/orbis/snapshots
sudo python3 SOURCE/scripts/orbis-host-service.py \
  --root ROOT \
  --docker-context default \
  --socket /run/orbis/host.sock \
  --snapshots /var/lib/orbis/snapshots \
  --state-dir /var/lib/orbis/state
```

In the copied installation's existing `user-config/tipi-compose.yml`, merge the following under the existing `runtipi` service, preserving every existing user setting:

```yaml
services:
  runtipi:
    volumes:
      - /run/orbis:/run/orbis:ro
    environment:
      ORBIS_HOST_SOCKET: /run/orbis/host.sock
```

The helper's socket is owned by the host process with mode `0600`. The container needs permission to connect through the mounted directory. A Compose change invalidates Orbis's saved enrollment fingerprint; a controlled core recreation and fresh enrollment are required before the host service can plan an update. The socket mount and host transaction passed in the isolated VM; service persistence under a process supervisor still needs testing before an installer can automate it. A mounted socket is a privileged control channel; never mount it into application containers or expose it through a TCP port.

The UI remains read-only when `ORBIS_HOST_SOCKET` is absent, the socket cannot be reached, the running image differs from enrollment, or the host reports an interrupted job. An interrupted job exposes a specific recovery action. Host operating system package updates remain unimplemented and separate from this core updater.
