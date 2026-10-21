# Inspect an existing installation

With Python 3.10+ and Docker access, run this from an Orbis source checkout on the Docker host you want to inspect:

```sh
python3 scripts/orbis-install-detect.py --docker-context default
```

Use the appropriate context name if Docker is configured with several hosts. The command does not change your selected context.

The JSON report identifies Runtipi and Orbis controllers, their versions and installation paths. It checks Compose ownership, mounted configuration files, managed app storage, reserved container names and Docker-published ports. External bind mounts, named volumes and temporary storage are listed separately. Apps whose owning installation cannot be established remain unassigned for review. Multiple installations require explicit selection. An existing Orbis controller is reported separately from Runtipi.

The command only reads Docker metadata. It does not read environment values, pull images, stop containers, change files or authorize a replacement. Failed or incomplete Docker inspection returns an error instead of reporting an empty server. Host files and ports used by services outside Docker require a subsequent installation review.

A stopped controller remains discoverable while its container exists. If its containers have been removed, its saved files must be checked when choosing the installation directory; `no-controller-found` does not establish that the directory is empty.

## First sign-in

An existing account or saved login session still opens Orbis setup on first use. Confirm the server name, display mode and optional error reporting, and choose whether to open server pairing next. Completing setup preserves the account and installed apps. Completion is stored on the server for that account, independently of the inherited welcome flag and browser appearance cache. It persists across browsers, logins and appearance resets.

For the existing explicit-root migration tools and their supported layouts, see [Installation and migration](DEPLOYMENT.md).

## Installer permissions and replacement choices

`docker pull` downloads an image. Detection, a setup screen and replacement require a running installer on the selected Docker host. Reaching a dashboard over HTTP does not provide Docker or filesystem access.

The release installer has two replacement choices:

- **Replace Runtipi and keep data:** preserve accounts, encryption keys, settings, apps, app data and storage mappings.
- **Replace Runtipi and start fresh:** reset Orbis accounts and dashboard preferences while retaining existing app containers and data. Detect those apps again, adopting compatible Runtipi app metadata and listing other Docker workloads as external apps. Retain the previous installation for rollback.

Recognized Runtipi apps need their app/store identity, configuration, overrides and storage mappings to retain managed-app features. A container name or image alone is insufficient to reconstruct them. External app removal must identify the selected app's containers without removing Orbis infrastructure or implicitly deleting persistent data.

Replacing the controller does not reverse database migrations or configuration changes made by a newer Runtipi version. The current migration tools support Runtipi 4.10.1 and must reject unsupported versions or layouts before modifying the installation. Runtipi also [warns against downgrading without a backup](https://runtipi.io/docs/reference/using-the-cli) and documents [breaking changes between versions](https://runtipi.io/docs/reference/breaking-updates).

The installer needs Docker control plus access to the installation, external data and backup destinations. A host bootstrapper can provide this without a generally privileged container. Docker control on a rootful daemon itself confers host administration privileges; mounting its socket read-only does not restrict Docker API methods. Never publish an unauthenticated Docker API for installation.

A separate host executor must handle the transaction so replacing the dashboard cannot stop its own installer. Separate installations can coexist with isolated ports, container names and data, but the replacement flow must stop the old controller before claiming its resources. Two controllers must never use the same writable database or installation tree.

The Linux installer uses a terminal for discovery, replacement choices and confirmation. The first browser sign-in completes account setup. The executor commands below remain available for reviewed maintenance and recovery.

## Release installer

Releases that include `install-orbis.py` also provide `orbis-installer-manifest.json` and `orbis-installer.tar.gz`. The launcher is bound to that release's source commit, image manifest and archive hash. It checks every packaged file before running the installer. No repository checkout is required; prompts read the terminal even when the launcher is supplied through a pipe.

The supported host is 64-bit Linux with systemd, Python 3.10 or newer, a local rootful Docker Engine with API 1.44 or newer, Docker Compose, Git and rsync 3.1.3 or newer. Run with root privileges. The installer accepts an explicit Docker context and refuses remote Docker endpoints for host filesystem operations.

- A discovered Runtipi CLI 4.10.1 installation offers **Keep** or **Fresh**, followed by the selected root, app-container count and private backup location. Native and remote storage writers must be stopped before replacement.
- A new installation requires an empty directory and free dashboard ports. It creates private configuration, PostgreSQL 17, RabbitMQ 4 and Traefik 3.6 using pinned images. Database and queue ports remain private. Migration retains the original database and dependency configuration.
- Successful setup enables the restricted systemd helper and a read-only host-socket mount. The helper provides browser-managed core and host operations. `--without-host-service` explicitly omits those host operations.
- Interrupted initialization records its original source and journal. Rerunning the installer for that root offers recovery. Replacement recovery restores the original installation before activation or finishes the cutover after activation; new-server and helper setup recover forward without restoring over accepted app writes.

Private installer and recovery files remain under `/var/lib/orbis/installer` by default. Preserve them when an operation fails. A launcher never substitutes a different release silently. Use a release with the required external-network protection for a new controller start.

An older Orbis beta without that protection must be updated before this installer can recreate its controller to attach the host service. An already healthy, enrolled helper can continue running without a controller restart.

For a read-only inventory from a reviewed source copy:

```sh
sudo python3 scripts/orbis-install.py --manifest MANIFEST.json \
  --state-dir /var/lib/orbis/installer/manual --docker-context default --inspect
```

Unattended replacement additionally requires `--root`, `--mode keep` or `--mode fresh`, `--yes` and `--host-writers-stopped`. Interactive operation asks for the mode and exact installation path. Existing configurations and unsupported versions are never treated as an empty installation.

## Replace Runtipi and keep data

`scripts/orbis-install-replace.py` operates on a running Runtipi CLI 4.10.1 installation. Run it as root on the Linux Docker host, with Docker Engine API 1.44 or newer and the storage recovery tools described below. Download the published release's `release-manifest.json`, verify it with `orbis-release-check.py`, and pull the exact verified image digest before reviewing replacement. Tags alone are not accepted.

The review verifies GitHub/GHCR release identity, the running controller and persistent Compose configuration. A temporary image probe reads the target's migration files without host mounts, network access or published ports. The installed PostgreSQL migration history must be an exact prefix of that image's history. Pending app operations, queued commands, unknown migration hashes and newer databases require review before downtime; no queue messages are purged.

Choose a new private backup and journal outside every storage source:

```sh
umask 077
python3 scripts/orbis-install-replace.py review ROOT \
  --docker-context CONTEXT --manifest MANIFEST.json \
  --backup BUNDLE --journal JOURNAL > REPLACEMENT-REVIEW.json
```

After separately stopping native and remote storage writers:

```sh
python3 scripts/orbis-install-replace.py apply ROOT \
  --docker-context CONTEXT --journal JOURNAL --review REPLACEMENT-REVIEW.json \
  --confirm-root ROOT --host-writers-stopped
```

The executor checkpoints the stopped installation and retains the original controller for rollback. Orbis first boots in hold mode, then verifies resume mode without publishing the dashboard's ports. Apps and the reverse proxy remain stopped during these checks. The persistent override changes the controller image and build identity; custom runtime mounts, network settings and resource limits are preserved.

Before app containers or public dashboard ports become available, the journal records `committing`. Recovery before that point restores the original controller and verified backup. Recovery after that point finishes installing Orbis, preserving newly accepted app writes. Success removes the stopped original controller, restores service restart policies and records the installation for the host updater. The backup remains private on the host. Installer phase flags are absent from the final controller and persistent Compose override.

For an interrupted or failed operation:

```sh
python3 scripts/orbis-install-replace.py recover ROOT \
  --docker-context CONTEXT --journal JOURNAL \
  --confirm-root ROOT --host-writers-stopped
```

The journal determines rollback or forward recovery. Completed and recovered journals cannot be replayed. Preserve the journal and backup if configuration drift prevents recovery. This executor handles replacement only; the release installer coordinates empty-server initialization and the optional host administration service.

## Replace Runtipi and start fresh

Use the same requirements, verified image, private backup and journal as Keep replacement. Add `--mode fresh` when reviewing and applying:

```sh
umask 077
python3 scripts/orbis-install-replace.py review ROOT \
  --docker-context CONTEXT --mode fresh --manifest MANIFEST.json \
  --backup BUNDLE --journal JOURNAL > FRESH-REVIEW.json
python3 scripts/orbis-install-replace.py apply ROOT \
  --docker-context CONTEXT --mode fresh --journal JOURNAL --review FRESH-REVIEW.json \
  --confirm-root ROOT --host-writers-stopped
```

Fresh removes controller accounts, their saved dashboard links, workspace preferences and first-use completion markers. It rotates the signing key and clears cached sessions, forward-auth grants and two-factor challenges before account IDs can be reused. Create a new administrator after activation. App/store metadata, configuration, encryption seed, app data and storage mappings are retained, so recognized Runtipi apps keep their management features. Other Docker workloads remain available through Docker app discovery.

This mode currently requires the standard writable `state`, `cache` and `.env` bind mounts. Custom account relationships, unknown cache formats, literal Compose signing-key overrides and custom state layouts are refused before downtime. The same recovery command restores the original installation before public activation or finishes the recorded cutover afterward. Keep the private backup and journal.

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

App ownership accepts both host Compose directories and the controller's `/data/apps/STORE/APP` paths. The latter must match the app's URN and the controller's apps bind mount. If multiple controllers share that internal path, the host helper requires a unique, canonical app directory containing a regular Compose file. Symlink aliases and unresolved ownership require review; unassigned managed containers are not stopped.

After the original controller has recovered and is healthy:

```sh
python3 scripts/orbis-install-apps.py resume ROOT --docker-context CONTEXT \
  --journal JOURNAL --confirm-root ROOT
```

After a replacement, add `--controller-image ghcr.io/twentylines/orbis@sha256:DIGEST` to require the exact new Orbis image instead. Resume restores the previous running/stopped states and restart policies, including retry counts. It can continue a partially completed stop or resume, but refuses to replay a completed transaction. Missing or replaced app containers, changed definitions, another Docker daemon and an unhealthy controller require review before further actions.

This step neither stops the controller nor proves data is ready for backup. The installation executor must stop the controller and all other writers, cover external storage, take a consistent backup, and prevent the replacement controller from starting app operations before resuming them. Keep the journal until the enclosing installation transaction is accepted or recovered.

## Checkpoint the running installation

The Linux host transaction helper coordinates the original controller, managed apps, database and queue. It requires root, local Docker access and the backup/recovery tools described below. It is a checkpoint and recovery command; it does not yet perform the replacement or reset accounts.

Choose a new `BUNDLE` and `JOURNAL` inside a private directory outside the installation and every external storage source. Review and save the plan privately:

```sh
umask 077
python3 scripts/orbis-install-transaction.py review ROOT \
  --docker-context CONTEXT --backup BUNDLE --journal JOURNAL > INSTALL-REVIEW.json
```

After separately stopping native host processes and remote writers that use this storage:

```sh
python3 scripts/orbis-install-transaction.py checkpoint ROOT \
  --docker-context CONTEXT --journal JOURNAL --review INSTALL-REVIEW.json \
  --confirm-root ROOT --host-writers-stopped
```

The command saves the original container identities, running states and restart policies before any changes. It disables automatic restarts, stops the controller before apps, then stops the queue and database. It captures and verifies all reviewed storage. Success leaves those containers stopped and the journal at `ready`.

To recover, including after an interrupted stop or copy:

```sh
python3 scripts/orbis-install-transaction.py recover ROOT \
  --docker-context CONTEXT --journal JOURNAL \
  --confirm-root ROOT --host-writers-stopped
```

Recovery quiesces the reviewed writers again, restores a completed verified checkpoint when available, starts the original services and running apps, checks controller health, and restores their restart policies. Originally stopped or never-started apps remain so. An interrupted recovery can continue; a completed one cannot be replayed. Container replacement, definition changes, unreviewed policy changes, a different daemon or a damaged completed backup cause a refusal. Keep the private journal and backups when a command fails. An interrupted native copy retains the installation lock until it exits, so recovery cannot race it.

An incomplete backup from a failed checkpoint is never used for restore. No replacement or reset has occurred at that stage, so recovery can restart the original services. This helper currently requires those original containers to remain present. Use the replacement executor above for a controller cutover; first-install bootstrap remains under development.

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

Capture rechecks Docker identities, mount definitions, nested host mounts, source identities and writer states. It verifies copied bytes, ownership, permissions and nanosecond timestamps, and rereads the sources after the collection finishes. New Linux collections also seal extended attributes, ACLs and hard-link groups within each resource. Hard links crossing resource boundaries or pointing outside the collected storage require manual review and are refused before copying. A controller's Docker socket must match the selected local context. Data files and directory entries are flushed before publishing verification records. A changed source, restarted writer, missing resource or failed copy leaves an incomplete backup. Verification works independently of the original source paths and rejects incomplete or changed backups.

## Recover installation storage

The source includes a separate stopped-writer recovery helper. Run it as root on the Linux Docker host with rsync 3.1.3 or newer, built with ACL and extended-attribute support. Every writer must remain stopped with automatic restarts disabled, including native processes and remote storage clients.

Review recovery against the original root and Docker daemon, then save that review privately:

```sh
umask 077
python3 scripts/orbis-install-restore.py review BUNDLE \
  --root ROOT --docker-context CONTEXT > RESTORE_REVIEW.json
```

The review binds the backup, destination identities and current container definitions. `extendedMetadataSealed` reports whether the collection includes the newer attribute and hard-link seals. Older collections still verify the fields recorded when they were created.

Restoration replaces the contents of the reviewed resources with the backup, including removing files created afterward. `RESTORE_JOURNAL.json` must be outside every destination and the backup:

```sh
python3 scripts/orbis-install-restore.py restore BUNDLE \
  --root ROOT --docker-context CONTEXT --review RESTORE_REVIEW.json \
  --journal RESTORE_JOURNAL.json --confirm-root ROOT --host-writers-stopped
```

After an interruption, inspect the private journal and confirm that writers are still stopped. Use the same command with `recover` instead of `restore`. Recovery replays and verifies every resource; it does not trust previously completed resource indexes. A completed journal cannot be replayed.

The helper preserves file-mount inodes, restores directory contents and metadata, and checks the restored data before completing its journal. It neither starts containers nor replaces the controller. Hard links spanning separate resource roots are not reconstructed; the complete migration executor must handle that topology before using this helper for such installations.

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
