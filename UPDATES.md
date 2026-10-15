# Orbis Update Center: implementation contract

Orbis will make application, Orbis core, and host operating system updates visible in the browser with the release notes that belong to each update. These are separate operations with different permissions and rollback paths.

## Application updates

Keep Runtipi's installed app identities, store metadata, compatibility checks, generated forms, and existing app update service. The Update Center should reuse the current app version and lifecycle APIs, link to each app's configured store entry, and show the store's supplied release notes when present. It must report when a store provides no changelog. App-store refresh must never replace the Orbis core image.

## Orbis releases

Use GitHub Releases from the Orbis repository as the changelog source. Show the installed commit/image digest, available release tag, publication time, release notes, and whether a compatible image is available. The backend reads the public release feed and immutable tagged notes without a GitHub credential, then caches them for 15 minutes. Applying a release uses a reviewed image digest and a separate host service with a stopped-state snapshot and rollback path. The stock `scripts/install.sh` downloads upstream Runtipi and must not be presented as an Orbis updater.

The upstream Runtipi CLI `start` and `update` paths also pull and run the upstream core without Orbis's Compose override. A production Orbis install must have an Orbis-owned host controller before these commands are retired; a staged override alone is not durable across stock CLI operations.

The host command `scripts/orbis-host-update.py` handles a digest-pinned core update on an already enrolled CLI v4.10.1 installation. It verifies the published release, takes a stopped-state checksum snapshot, and rolls back on a failed start. A restricted Unix socket host service and authenticated operator API expose a reviewed plan, apply, job status, and interrupted recovery. The socket mount, systemd supervision, full VM restart, and browser-clicked updates through beta 13 passed on synthetic arm64 data. A first-install setup tool validates the enrolled core and mount before installing root-owned helper scripts and a systemd unit. A separate in-place helper upgrade passed success, injected-failure rollback, and recovery checks; the upgraded helper then applied beta 13 in the browser. This is still a preview without a real-data rehearsal. A GitHub tag alone does not mean a tested image can be installed.

## Host operating system updates

The Orbis Docker container cannot safely update the host through a general-purpose terminal or unrestricted Docker socket API. The separately installed host service reads Ubuntu 24.04 APT candidates and distribution changelogs. It also accepts a short-lived reviewed package plan and applies it through a systemd worker after an operator confirms every planned upgrade and new dependency. The helper uses a fixed APT argument list, exact candidate versions, trusted sources, and no package removals. It records a private job and log, and does not reboot. Repository index refresh, failure repair, and reboot controls remain separate work. Hades's distribution and update method need live inventory before an adapter is chosen.

The browser should display each package's repository, installed and candidate versions, security classification when supplied by the package manager, changelog source, download size when known, reboot requirement, and a timestamp for the last successful check. Unavailable changelogs and failed checks must be labelled. Never run an opaque `curl | sh` or arbitrary browser-supplied command as an update action.

For the later multi-homelab design, the paired host agent can provide this same restricted update interface per server. The controller must show which host an update will affect and retain per-host progress and rollback records.

## Current status

The fork preserves Runtipi app update mechanisms and links available versions to their real app-detail review. The browser reads Orbis release notes and installed build metadata through the authenticated backend. Protected release jobs publish digest-pinned amd64/arm64 images and a matching manifest; the release checker verifies the tag, commit and exact GHCR image-index bytes. Browser-reviewed core updates through beta 21 have passed on the isolated arm64 installation with exact published digests and healthy enrollment. The beta 20→21 transaction retained settings, app configuration and task history; current build and job state were checked after completion.

The released beta 15 browser selected and reviewed one pinned `distro-info-data:arm64` upgrade, applied it through the detached systemd worker, and showed completion. The host reported the reviewed version and a clean `dpkg --audit`. Earlier helper setup, upgrade, injected-failure rollback, core recovery and VM restart rehearsals are recorded in [DEPLOYMENT.md](DEPLOYMENT.md). These are synthetic/isolated proofs; they do not validate Hades or amd64 runtime.

Current limits include copied real-data migration, external mounts/volumes, representative backup space/downtime, supported production installation, package-index refresh, failed APT repair and reboot controls. Hades cutover remains a separate approved phase. A published release is an iteration, not completion of [ACCEPTANCE.md](ACCEPTANCE.md).
