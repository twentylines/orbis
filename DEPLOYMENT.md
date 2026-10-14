# Orbis build and migration rehearsal

The source tree builds and passes unit, browser-fixture, clean-install Docker, disposable-app lifecycle, and a synthetic stock CLI migration rehearsal. It has **not** passed migration against a copy of an existing homelab. Do not use it to replace a live Runtipi installation yet.

## Verified clean-install smoke test (15 October 2026)

An isolated Colima Linux VM with its own Docker socket built the Orbis image from this tree. The test Compose project used a fresh Postgres volume, loopback-only ports 18080/18443/18081, and no published Postgres port. The image and dependencies started healthy; `/api/health` returned 200. A fresh account registered through the real browser, completed the welcome step, and opened Workspace, Monitor, Updates, App Store, Applications, and Settings without page errors or horizontal overflow at 1440 × 900. The official store was present and the marketplace search reported 248 entries. Unauthenticated telemetry and desktop-preference reads returned 401; authenticated reads and preference save/reload succeeded. [Live screenshots](screenshots/live-smoke) and the repeatable [smoke script](scripts/live-smoke.cjs) capture this check. The script registers a new first user and therefore accepts only a loopback test stack with an empty database.

That first check verifies clean startup and key read paths. The separate app lifecycle check below covers one disposable application. No existing Runtipi data was imported. Host operating system updates and Orbis core updates are scoped in [UPDATES.md](UPDATES.md) and are not implemented yet.

## Verified disposable app lifecycle (15 October 2026)

The same isolated VM was reset to an empty database and ran `ORBIS_SMOKE_LIFECYCLE=1 node scripts/live-smoke.cjs`. It installed the official Whoami app, reached running state, stopped, started, restarted, created and listed a backup, reset, restored that backup, and uninstalled while removing the archive. All operations completed through the authenticated browser API, and no application container remained. This verifies one small app on a clean installation; app updates, custom stores, external URLs, TOTP, HTTPS routing, and real existing-install data remain untested.

## Synthetic stock CLI migration and rollback (15 October 2026)

In the isolated Colima VM, the pinned Runtipi CLI v4.10.1 Compose template started the official `ghcr.io/runtipi/runtipi:v4.10.1` image with synthetic credentials, top-level data folders, `data/postgres`, and a `user-config/tipi-compose.yml` override for a loopback test port. A user registered, the official store loaded, and Whoami installed under `whoami:migrated`. With the app and core stopped, the entire installation tree was copied. A local Orbis image replaced only the core image through a final Compose override; the merged Compose model was checked to be otherwise unchanged. Orbis became healthy using the existing database and files, accepted the original session, reported one store and the same running app, then stopped and started that inherited app through its lifecycle API. The core and app were stopped again, the saved installation tree was restored, and stock Runtipi plus the app were recreated. Stock health, the original session, store, and app record all returned; `/api/system/build` returned 404 again as expected for stock.

This verifies the migration path for a small synthetic CLI install and rollback using a full stopped-state copy. It does not validate a copy of Hades, large app data, external paths, user app overrides, custom stores, HTTPS domains, or rollback after an Orbis database migration. The local image was not a published digest-pinned release.

## Isolated Linux test host

Use a disposable Linux VM with its own Docker daemon and no production volumes, network, or Docker context. Runtipi v4.10.1 remains the compatibility base. The fork builds its own `runtipi` image from [Dockerfile](Dockerfile) through [docker-compose.prod.yml](docker-compose.prod.yml); the Compose file's `TIPI_VERSION` is set to `4.10.1` for app compatibility. Keep the source revision and resulting image digest together in test records.

1. Copy this repository into the disposable VM. Check that `docker context show` identifies that VM's own daemon.
2. Create `.env` from `.env.example` and fill the settings required by the test VM. Do not copy Hades credentials or volumes for the initial clean-install run.
3. Run `docker compose --project-name runtipi -f docker-compose.prod.yml config` and review the merged mounts, ports, and network names before starting anything.
4. Run `docker compose --project-name runtipi -f docker-compose.prod.yml up --build -d` in the test VM. The base Compose file publishes ports 80, 443, 8080, and 5432, so keep this VM isolated and verify these bindings suit its network.
5. Confirm `/api/health`, registration/login, TOTP, official and custom store refresh, a disposable app install/update/start/stop/restart/reset/uninstall, backup/restore, custom app and link management, HTTPS routing, and the new authenticated telemetry/preferences endpoints. Verify failures and reconnect behavior as well as success.
6. Record `docker compose ps`, targeted service logs, browser results, and the image digest. Remove only this disposable test environment after collecting the evidence.

## Rehearse import on a copy

Runtipi's own folders and database are the import format. The fork keeps the original app/store/lifecycle services; there is no importer that guesses or rewrites app definitions. A successful import means the fork starts against an **isolated, consistent copy** of the installation tree and Postgres data, runs its normal migrations, and shows the same users, app URNs, stores, configuration, and app data. The Runtipi v4.10.1 CLI install uses top-level `apps`, `app-data`, `state`, and other data folders plus `data/postgres`. This differs from this repository's development Compose file, which uses `.internal` and a `pgdata` volume.

1. Capture a consistent source snapshot and database backup under an approved procedure. Include any custom `RUNTIPI_*_PATH` mounts, `.env`, Traefik state, app data, user config, media, and backups. For a CLI installation, include `data/postgres`; for a source Compose stack, include the Docker `pgdata` volume, which is **not** part of `.internal`.
2. Restore these into the disposable VM only. The same paths must resolve inside the VM's Compose configuration. The fork and stock core must never use the same database or Docker daemon at once.
3. Run `python3 scripts/migration-preflight.py /path/to/copied/runtipi` against the copied installation. It identifies the CLI or source Compose layout and reports only presence and counts; it does not print `.env` values, follow external path overrides, query Docker, import files, or validate Postgres. Resolve every review item manually.
4. Record before/after hashes for the copied files and database row counts, then boot the fork in the VM. Check every installed app identity, generated/user Compose override, bind mount, external network, URL, secret-dependent setting, and custom store. Exercise backup/restore and a rollback to the stock v4.10.1 image using the untouched snapshot.
5. Treat a migrated installation as verified only when its applications run and can be launched through their actual URLs. A successful UI render or health endpoint alone does not establish compatibility.

For a copied CLI v4.10.1 installation, `python3 scripts/orbis-release-plan.py /path/to/copied/runtipi /path/to/release-manifest.json` validates a reviewed Orbis digest manifest and asks Docker Compose to merge the existing stack, `user-config/tipi-compose.yml` when present, and a proposed Orbis core image override. It reports only image identity and whether the Compose merge changes anything beyond the core image/build identity. It never prints generated environment values, pulls images, starts containers, or writes the override. This plan is a prerequisite for a migration rehearsal, not an installer.

## Later Hades cutover

Hades remains untouched during current development. Before a later cutover, the exact installed Runtipi version, Compose file, environment, mount overrides, Postgres volume, app list, and running services must be inventoried live. After the copy rehearsal passes and the user explicitly approves production deployment, prepare a consistent snapshot, record current image digests, quiesce only the stock core, deploy the tested fork with the same data layout, verify the applications and external access, and keep the stock image and snapshot ready for rollback. Never run both cores on the same live data at the same time.

The stock `scripts/install.sh` downloads official Runtipi releases, so it is **not** the fork deployment path. The Settings screen distinguishes upstream core releases from this fork; app-store refresh remains a separate operation. Fork updates must be built from reviewed source and applied through a guarded, reversible procedure.

## Orbis release packaging

The tag workflow in [.github/workflows/release.yml](.github/workflows/release.yml) publishes an Orbis-owned multi-architecture image and a GitHub Release containing its digest manifest and tag-specific notes. It cannot run until `releases/<tag>.md` exists and CI plus integration tests pass. The inherited nightly, upstream CLI, and upstream installer release jobs have been removed. Image publication alone does not install an update; the controller, backup, rollback, and copied-data rehearsal remain outstanding.
