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
- **Replace Runtipi and start fresh:** initialize an empty Orbis installation and retain the previous installation for rollback.

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

`stop` disables automatic restarts for every reviewed app container, then stops the ones that were running. A changed plan is rejected before any container mutation. The private journal is written before changes and survives process termination. Do not repeat `stop` using an existing journal.

After the original controller has recovered and is healthy:

```sh
python3 scripts/orbis-install-apps.py resume ROOT --docker-context CONTEXT \
  --journal JOURNAL --confirm-root ROOT
```

After a replacement, add `--controller-image ghcr.io/twentylines/orbis@sha256:DIGEST` to require the exact new Orbis image instead. Resume restores the previous running/stopped states and restart policies, including retry counts. It can continue a partially completed stop or resume, but refuses to replay a completed transaction. Missing or replaced app containers, changed definitions, another Docker daemon and an unhealthy controller require review before further actions.

This step neither stops the controller nor proves data is ready for backup. The installation executor must stop the controller and all other writers, cover external storage, take a consistent backup, and prevent the replacement controller from starting app operations before resuming them. Keep the journal until the enclosing installation transaction is accepted or recovered.
