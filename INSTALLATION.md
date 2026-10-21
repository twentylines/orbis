# Inspect an existing installation

With Python 3.10+ and Docker access, run this from an Orbis source checkout on the Docker host you want to inspect:

```sh
python3 scripts/orbis-install-detect.py --docker-context default
```

Use the appropriate context name if Docker is configured with several hosts. The command does not change your selected context.

The JSON report identifies Runtipi and Orbis controllers, their versions and installation paths. It checks Compose ownership, mounted configuration files, managed app storage, reserved container names and Docker-published ports. External bind mounts, named volumes and temporary storage are listed separately. Apps whose owning installation cannot be established remain unassigned for review. Multiple installations require explicit selection. An existing Orbis controller is reported separately from Runtipi.

The command only reads Docker metadata. It does not read environment values, pull images, stop containers, change files or authorize a replacement. Failed or incomplete Docker inspection returns an error instead of reporting an empty server. Host files and ports used by services outside Docker require a subsequent installation review.

A stopped controller remains discoverable while its container exists. If its containers have been removed, its saved files must be checked when choosing the installation directory; `no-controller-found` does not establish that the directory is empty.

For the existing explicit-root migration tools and their supported layouts, see [Installation and migration](DEPLOYMENT.md).

## Installer permissions and replacement choices

`docker pull` downloads an image. Detection, a setup screen and replacement require a running installer on the selected Docker host. Reaching a dashboard over HTTP does not provide Docker or filesystem access.

The installation flow being developed has two replacement choices:

- **Replace Runtipi and keep data:** preserve accounts, encryption keys, settings, apps, app data and storage mappings.
- **Replace Runtipi and start fresh:** reset Orbis accounts and dashboard preferences while retaining existing app containers and data. Detect those apps again, adopting compatible Runtipi app metadata and listing other Docker workloads as external apps. Retain the previous installation for rollback.

Recognized Runtipi apps need their app/store identity, configuration, overrides and storage mappings to retain managed-app features. A container name or image alone is insufficient to reconstruct them. External app removal must identify the selected app's containers without removing Orbis infrastructure or implicitly deleting persistent data.

Replacing the controller does not reverse database migrations or configuration changes made by a newer Runtipi version. The current migration tools support Runtipi 4.10.1 and must reject unsupported versions or layouts before modifying the installation. Runtipi also [warns against downgrading without a backup](https://runtipi.io/docs/reference/using-the-cli) and documents [breaking changes between versions](https://runtipi.io/docs/reference/breaking-updates).

The installer needs Docker control plus access to the installation, external data and backup destinations. A host bootstrapper can provide this without a generally privileged container. Docker control on a rootful daemon itself confers host administration privileges; mounting its socket read-only does not restrict Docker API methods. Never publish an unauthenticated Docker API for installation.

A separate host executor must handle the transaction so replacing the dashboard cannot stop its own installer. Separate installations can coexist with isolated ports, container names and data, but the replacement flow must stop the old controller before claiming its resources. Two controllers must never use the same writable database or installation tree.

The complete browser setup and both replacement transactions are not available yet. The commands below prepare app containers only; they do not perform a takeover or create a backup.

## Prepare app containers for an installation transaction

`scripts/orbis-install-apps.py` records the exact containers belonging to one discovered installation. The plan includes their identities, definition fingerprints, running states and Docker restart policies. It refuses ambiguous ownership, transient states and containers that would be deleted automatically when stopped.

```sh
python3 scripts/orbis-install-apps.py plan ROOT --docker-context CONTEXT
```

An installer must review that plan before calling `stop` with its exact `reviewId`. `JOURNAL` must be a new file in a private directory owned by the installer user, outside `ROOT`:

```sh
python3 scripts/orbis-install-apps.py stop ROOT --docker-context CONTEXT \
  --journal JOURNAL --review-id REVIEW_ID --confirm-root ROOT
```

`stop` disables automatic restarts for every reviewed app container, then stops the ones that were running. A changed plan is rejected before any container mutation. Docker mount ordering is normalized; changes to mount sources, destinations or permissions still invalidate the review. The private journal is written before changes and survives process termination. Do not repeat `stop` using an existing journal.

After the original controller has recovered and is healthy:

```sh
python3 scripts/orbis-install-apps.py resume ROOT --docker-context CONTEXT \
  --journal JOURNAL --confirm-root ROOT
```

After a replacement, add `--controller-image ghcr.io/twentylines/orbis@sha256:DIGEST` to require the exact new Orbis image instead. Resume restores the previous running/stopped states and restart policies, including retry counts. It can continue a partially completed stop or resume, but refuses to replay a completed transaction. Missing or replaced app containers, changed definitions, another Docker daemon and an unhealthy controller require review before further actions.

This step neither stops the controller nor proves data is ready for backup. The installation executor must stop the controller and all other writers, cover external storage, take a consistent backup, and prevent the replacement controller from starting app operations before resuming them. Keep the journal until the enclosing installation transaction is accepted or recovered.

## Capture installation storage

The source includes a Linux host helper for collecting the installation tree, external bind-mounted directories and files, and accessible local Docker volumes into one private backup. Nested sources are copied once. Temporary filesystems, kernel/device mounts, the Docker control socket and read-only host timezone inputs are excluded.

Run as root on the Docker host. `BUNDLE` must be a new destination in a private directory outside every source. Save the review privately:

```sh
umask 077
python3 scripts/orbis-install-storage.py review BUNDLE \
  --root ROOT --docker-context CONTEXT > REVIEW.json
```

The installation executor must stop every reviewed core and app container and disable its restart policy before capture. Other containers with writable mounts over these sources must also be stopped with restarts disabled. Native host processes and remote storage writers require separate review and shutdown; Docker metadata cannot prove they are quiet.

```sh
python3 scripts/orbis-install-storage.py capture BUNDLE \
  --root ROOT --docker-context CONTEXT --review REVIEW.json \
  --confirm-root ROOT --host-writers-stopped
python3 scripts/orbis-install-storage.py verify BUNDLE
```

Capture rechecks Docker identities, mount definitions, source identities and writer states. It verifies copied bytes, ownership and permissions, checks file timestamps, and rereads the sources after the collection finishes. A changed source, restarted writer, missing resource or failed copy leaves an incomplete backup. Verification works independently of the original source paths and rejects incomplete or changed backups.

The enclosing installation executor is responsible for consistent database and queue shutdown, controller replacement, selective reset and stopped-writer rollback. This helper is part of the source implementation; the complete Keep/Fresh installer and its end-to-end rehearsals remain in development.

## Controller hold and resume modes

`v0.1.0-beta.63` and later include the `orbis.installation-state.v1` controller protocol. The release manifest and image label declare this capability; an executor must verify it before relying on hold or resume mode. The complete replacement installer remains in development.

Set both `ORBIS_INSTALLER_TRANSACTION` to a UUID v4 and `ORBIS_INSTALLER_PHASE` to `hold` or `resume` in the container environment. Incomplete or invalid input prevents startup. These values are captured before loading saved environment files; a saved file cannot release a held process. Changing the phase requires recreating the controller. There is no HTTP operation to release it.

In `hold`, the controller runs database migrations but skips app bootstrap, queue consumers and publication, scheduled jobs, task recovery and metric collectors. API requests receive `503 ORBIS_INSTALLATION_IN_PROGRESS`, except read-only health and installation status requests. `GET /api/installation/status` reports the phase and transaction ID. A healthy held container is not a completed installation.

Hold mode is not a read-only preview: startup can write migrations, generated environment files, logs and configuration defaults. Take and validate the enclosing transaction's rollback backup before starting the replacement controller, and keep all other writers stopped.

In `resume`, pending restores prevent startup. App queue consumers remain disabled while the controller checks for pending app commands or another consumer, prepares its services and reconciles app status. It checks the app queue again before enabling app commands. Pending app messages are preserved and cause startup to fail; the installer must recover or review them rather than purge them. Resume skips automatic app restarts and global network pruning so the independent executor can preserve the reviewed containers and their running states.

## Detected Docker apps

`v0.1.0-beta.63` and later include a **Docker apps** section in Apps.

Containers belonging to a Compose project are grouped using their project and configuration location. Other containers appear individually. Orbis infrastructure and apps already registered in the Orbis library are excluded from this list. Runtipi-labelled containers without an imported app record are identified as needing import; this list does not reconstruct missing Runtipi configuration from an image name.

Uninstall opens a review of the exact containers and their persistent storage. The server requires authentication and the matching review fingerprint, rechecks container membership and definitions, stops the selected containers, and removes them without force or volume deletion. Bind-mounted files and named or anonymous Docker volumes are retained. Files stored only in a container's writable layer are removed with the container. Automatically removed containers are currently blocked because Docker may remove their anonymous volumes when stopped.

Progress appears in Tasks with the app name. A private operation record is stored under `state/orbis-docker-apps/`; it includes container identities and retained storage, not environment values. Interrupted removals are not replayed automatically. Refresh the app list and review any remaining containers before retrying. Other tools can recreate a removed app, so disable any external deployment automation separately when retiring it.
