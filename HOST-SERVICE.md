# Orbis host service preview

The browser can now request a reviewed Orbis core update through an authenticated API and a separate host process. The host process listens on a Unix socket only. It accepts fixed core operations for status, planning, applying, and recovering a release. It also serves read-only Ubuntu 24.04 APT upgrade inventory and one exact candidate's distribution changelog. It has no shell endpoint or host package installation action.

This is currently a **disposable-host test path**. It has unit and socket transport tests, published beta 7 → beta 9 updates through the Linux VM's native socket, and browser-clicked updates from beta 9 through beta 13 from the real Update Center. Its systemd unit survived a service restart and VM stop/start, and the beta 12 → beta 13 update passed after upgrading the installed helper. Do not attach it to Hades or another production installation. See [DEPLOYMENT.md](DEPLOYMENT.md) for the transaction evidence and limits.

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

Replace both `ROOT` values with the same canonical absolute installation path and choose the enrolled Docker context. `install` takes the host-operation lock, copies the fixed helper script set to root-owned `/opt/orbis/host-service`, writes a private `/etc/orbis/host-service.env`, installs [packaging/systemd/orbis-host.service](packaging/systemd/orbis-host.service), verifies and enables the unit, then checks the socket both on the host and inside the Orbis core. It refuses an existing installation or an incorrect confirmation path. On a setup failure it disables the new unit and removes files it created. A later helper upgrade uses the separate command below; do not replace its scripts during a running core update.

The unit keeps `/run/orbis` across service restarts, so a running container does not retain an orphaned bind mount. In the isolated VM, the corrected installer returned an active service with mode `0700` script, state, and snapshot directories and mode `0600` environment and socket; the core reached the socket after a unit restart and a full VM stop/start. It still requires an external-data rehearsal and independent backup before any production cutover.

## Upgrade an installed helper

The Orbis container image does not replace files under `/opt/orbis/host-service`. Run [scripts/orbis-host-service-upgrade.py](scripts/orbis-host-service-upgrade.py) from a reviewed checkout on the Linux host after the first-install setup has succeeded:

```sh
python3 scripts/orbis-host-service-upgrade.py plan ROOT --docker-context CONTEXT
sudo python3 scripts/orbis-host-service-upgrade.py upgrade ROOT --docker-context CONTEXT --confirm-root ROOT
```

The plan checks the enrolled image, Compose socket mount, live host/container mount identity, root-owned helper files, systemd unit and environment, and absence of a running or interrupted core update. It reports hashes of the installed and candidate scripts and unit. Identical hashes return without a service restart. Otherwise upgrade takes the host-operation lock, marks maintenance so the newer helper refuses new core operations, stops the old unit, replaces scripts and unit from a same-filesystem staging area, starts the unit, then checks the socket from both the host and core and checks the bind-mount identity. If startup or verification fails, it restores the previous scripts and unit. The environment and installation data tree are unchanged.

If the upgrade command is interrupted, use the same checkout and exact root/context to recover the recorded helper transaction:

```sh
sudo python3 scripts/orbis-host-service-upgrade.py recover ROOT --docker-context CONTEXT --confirm-root ROOT
```

Recovery restores the previous helper when replacement did not finish, or finalizes a verified replacement. A failed rollback leaves its private maintenance record and staging directory in place for local inspection. The isolated VM passed an upgrade from the beta 11 installed helper, a deliberately broken replacement that restored the previous helper, a simulated interrupted setup, and finalization of an already verified replacement. The core stayed healthy at beta 12 and the saved core-update job remained complete. This is still a disposable-host result; do not apply it to Hades before the copied-data rehearsal and phase-two approval.

The UI remains read-only for core updates when `ORBIS_HOST_SOCKET` is absent, the socket cannot be reached, the running image differs from enrollment, or the host reports an interrupted job. An interrupted job exposes a specific recovery action. Host package inventory and changelogs use the same socket and operator guard. The beta 13 installed helper was upgraded in the isolated Ubuntu 24.04.4 VM; it returned 110 candidates and a real `base-files:arm64` changelog. It did not run `apt update`, install packages, or reboot the host. Browser package layout passed desktop and phone fixtures; host package installation remains unimplemented.
