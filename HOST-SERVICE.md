# Orbis host service preview

The browser can now request a reviewed Orbis core update through an authenticated API and a separate host process. The host process listens on a Unix socket only. It accepts four fixed operations: read status, plan a published release, apply one short-lived plan, and recover one interrupted transaction. It has no shell endpoint or host package update action.

This is currently a **disposable-host test path**. It has unit and socket transport tests, published beta 7 → beta 9 updates through the Linux VM's native socket, and browser-clicked beta 9 → beta 10 → beta 11 updates from the real Update Center. Its systemd unit survived a service restart and VM stop/start. Do not attach it to Hades or another production installation. See [DEPLOYMENT.md](DEPLOYMENT.md) for the transaction evidence and limits.

## Boundaries

- The host service uses the explicit installation root and Docker context supplied at startup. A browser request can contain only a release tag or a server-issued plan/job ID.
- A plan verifies the GitHub tag, release manifest, GHCR index digest and supported platforms, existing enrollment, healthy running image, Compose delta, stopped managed apps, and snapshot capacity. Plans expire after 15 minutes.
- Apply rechecks those conditions, pulls before downtime, captures a stopped-state snapshot, starts the digest-pinned release, and uses the existing automatic rollback transaction. The host service keeps running while the Orbis container restarts. A job record is saved outside the installation.
- The backend routes require an authenticated operator session. The inherited `AuthGuard` checks same-origin POST requests; a second guard rejects non-operators and CLI tokens. Only the Orbis backend should receive the Unix socket mount; keep the socket directory and service state private.
- External app mounts, named volumes, and real homelab data still require a copied-data rehearsal and independent backup. The existing updater leaves managed apps stopped. The stock Runtipi CLI `start` and `update` commands are incompatible with an adopted Orbis installation.

## Isolated Linux setup used for beta 8

Use a disposable Linux host with its own Docker daemon and an already enrolled Orbis CLI v4.10.1 copy. Choose actual absolute paths for `ROOT` and `SOURCE` on that host. The host process needs Python 3, Docker Compose, `rsync`, `git` for rate-limit fallback, and access to the Docker daemon. The source revision must contain `scripts/orbis-host-service.py` and its sibling host transaction scripts.

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

The helper's socket is owned by the host process with mode `0600`. The container needs permission to connect through the mounted directory. A Compose change invalidates Orbis's saved enrollment fingerprint; a controlled core recreation and fresh enrollment are required before the host service can plan an update. The socket mount, host transaction, and systemd restart passed in the isolated VM. A mounted socket is a privileged control channel; never mount it into application containers or expose it through a TCP port.

## Linux service setup

`scripts/orbis-host-service-setup.py` installs the helper on an **already enrolled** Linux systemd host whose running Orbis core has the read-only socket mount above. The socket directory must exist before that core container starts. The plan verifies the exact published image, saved enrollment, Docker context, merged Compose mount and environment, and host/container mount device and inode. A stale bind mount is rejected; recreate only the core under the reviewed Compose model before retrying. It does not edit Compose or adopt stock Runtipi.

```sh
python3 scripts/orbis-host-service-setup.py plan ROOT --docker-context CONTEXT
sudo python3 scripts/orbis-host-service-setup.py install ROOT --docker-context CONTEXT --confirm-root ROOT
```

Replace both `ROOT` values with the same canonical absolute installation path and choose the enrolled Docker context. `install` takes the host-operation lock, copies the fixed helper script set to root-owned `/opt/orbis/host-service`, writes a private `/etc/orbis/host-service.env`, installs [packaging/systemd/orbis-host.service](packaging/systemd/orbis-host.service), verifies and enables the unit, then checks the socket both on the host and inside the Orbis core. It refuses an existing installation or an incorrect confirmation path. On a setup failure it disables the new unit and removes files it created. This first-install tool is not an in-place upgrader or uninstaller; do not replace its scripts during a running update.

The unit keeps `/run/orbis` across service restarts, so a running container does not retain an orphaned bind mount. In the isolated VM, the corrected installer returned an active service with mode `0700` script, state, and snapshot directories and mode `0600` environment and socket; the core reached the socket after a unit restart and a full VM stop/start. It still requires an external-data rehearsal and independent backup before any production cutover.

The UI remains read-only when `ORBIS_HOST_SOCKET` is absent, the socket cannot be reached, the running image differs from enrollment, or the host reports an interrupted job. An interrupted job exposes a specific recovery action. Host operating system package updates remain unimplemented and separate from this core updater.
