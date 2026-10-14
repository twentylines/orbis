# Orbis implementation and deployment record

## Base and compatibility

This fork starts from Runtipi `v4.10.1`, commit `5734817389df55aafb9afd571e42e12ab7e647e0` (10 June 2026). The upstream project is GPL-3.0; `LICENSE` is retained. The repository is a Bun workspace: React Router frontend, Nest backend, Postgres, RabbitMQ, Traefik, Dockerode, generated OpenAPI client, and the official/custom store mechanism.

The visible product name, browser title, manifest, logo, and primary screens are Orbis. Internal Compose service names, package imports, API routes, and `RUNTIPI_*` environment keys retain their upstream names to keep existing installations and app definitions compatible. Hades remains only the editable default server display name.

Runtipi already provides authenticated application lifecycle, official and custom stores, dynamic install forms, custom apps, links, logs, backup/restore, reset, and system settings. Their routes and APIs remain the compatibility contract. The desktop work must not replace app definitions or duplicate app configuration.

## Phases

1. Replace the authenticated shell, dashboard, installed-app and store presentation. Keep existing action components and backend routes. Add a focused system monitor using real readings.
2. Complete server-persisted workspace and appearance settings, richer host telemetry, task history, window behavior, and accessibility/browser checks.
3. Validate a migration against a *copy* of a real Runtipi data tree in a disposable Linux VM and isolated Docker daemon. Check app URNs, stores, user config overrides, app data, database migrations, auth, Traefik, backup/restore, and rollback.
4. Only after explicit approval, take a Hades snapshot/backup, quiesce stock Runtipi, deploy the fork against the existing mount layout, verify every app and config, and retain a tested rollback path. No Hades changes occur in phases 1-3.

A later multi-homelab controller/agent phase is recorded in [MULTI-HOMELAB.md](MULTI-HOMELAB.md). It is intentionally downstream of single-server compatibility and migration validation.

The requested browser Update Center for apps, Orbis releases, and host packages is scoped in [UPDATES.md](UPDATES.md). Host updates require a restricted host helper and disposable-host validation before browser controls can apply them.

## Current implementation

- Authenticated server desktop shell with a responsive top bar, dock, first-party routes, keyboard tool and installed-app search, and logout through the existing API.
- Workspace populated from Runtipi's installed-app, links, and system-load APIs. App and store detail links keep their original routes and lifecycle components.
- System Monitor uses a new authenticated `/api/system/telemetry` endpoint for current per-core CPU, host-mounted memory and swap, runtime filesystems, and runtime network interfaces. Unavailable readings stay unavailable. Live charts keep at most 60 samples in the open browser view; there is no fabricated or persisted history.
- New per-user desktop appearance endpoint under `/api/desktop-preferences`, protected by Runtipi's `AuthGuard` and request validation. Data is stored under the existing `/data/state/desktop` mount, with browser caching and export/import of non-secret settings.
- Local, original SVG wallpaper. Login, app list, store, settings, and detail routes sit within the shared visual shell.
- Update Center shows installed-app update availability using existing store metadata and reads published Orbis release notes from GitHub. It labels host packages and in-browser core installation unavailable until the restricted helper and rollback path exist.
- Stock per-app reset, backup/restore, custom store, custom app, dynamic install form, and lifecycle code has not been removed.

## Current limits

- This is an implemented first slice, not yet a drop-in Runtipi replacement. The store and detail flows still need deeper visual work; task history, window controls, editable widgets, expanded monitoring, wallpaper upload, and theme options are pending.
- The existing `/system/load` endpoint reports CPU and filesystem data from the Runtipi runtime. The dashboard labels the filesystem accordingly. The new telemetry endpoint adds current runtime network and filesystem detail, but host-wide disks/network, temperatures, fans, GPU, container telemetry, and historical storage still need explicit host mounts or an agent design.
- Browser screenshots include labelled development fixtures and a clean-install run against an isolated Colima Docker daemon. The latter verified registration, welcome, main routes, authenticated telemetry/preferences, and a 248-entry official catalogue. Disposable-app lifecycle and copied-data migration remain untested.
- The official app-store connection uses the unchanged Runtipi mechanism. Catalogue search was verified on the clean install; refresh and install/update/uninstall behavior have not yet been retested against the disposable daemon.

## Compatibility and import design

The fork keeps the Runtipi data directory layout (`apps`, `app-data`, `user-config`, `repos`, `state`, `backups`, `traefik`, `media`, and logs) and the Runtipi Postgres database. Existing config should therefore be read by the original services when the same volumes and database are mounted. This is the intended automatic import path, not yet a verified migration. It requires a compatible database migration and must first be rehearsed against a copy. Do not point two live Runtipi cores at the same data or Docker daemon concurrently. Do not treat a filesystem copy alone as a successful import.

The rehearsal must include Hades's `migrated` app identities, generated and user Compose files, `user-config` overrides, app-data bind mounts, encrypted settings, custom stores, Postgres volume, `.env`, Traefik state, and external networks. Compare file hashes and database row counts before and after. Test rollback with a preserved image and data snapshot before cutover.

`scripts/migration-preflight.py` can inventory an isolated copy of a Runtipi installation without printing `.env` values or reading Docker state. It does not import data or validate the separate Postgres named volume. External data path overrides are flagged for manual review rather than followed outside the copy.

The existing per-app reset action is retained. An instance-wide reset needs a separate, explicitly specified destructive workflow with a verified backup, so it is not implemented by deleting the Runtipi data tree.

## Verification boundary

The macOS development machine uses a project-local Bun runner and an isolated Colima Linux VM for Docker tests. Bun installed dependencies and completed type checks, tests, and production bundles. `scripts/visual-qa.cjs` exercised fixture-based desktop and mobile routes in installed Chrome; `scripts/live-smoke.cjs` exercised a clean-install browser session and the real APIs against the VM. With `ORBIS_SMOKE_LIFECYCLE=1`, it also completed install, stop, start, restart, backup, reset, restore, and uninstall for the official Whoami app. The authenticated preference and build endpoints passed unit and live checks. Migration still requires a consistent copy of existing data in an isolated Linux environment. Hades is reserved for the later approved deployment phase.
