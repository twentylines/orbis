# Orbis Update Center: implementation contract

Orbis will make application, Orbis core, and host operating system updates visible in the browser with the release notes that belong to each update. These are separate operations with different permissions and rollback paths.

## Application updates

Keep Runtipi's installed app identities, store metadata, compatibility checks, generated forms, and existing app update service. The Update Center should reuse the current app version and lifecycle APIs, link to each app's configured store entry, and show the store's supplied release notes when present. It must report when a store provides no changelog. App-store refresh must never replace the Orbis core image.

## Orbis releases

Use GitHub Releases from the Orbis repository as the changelog source. Show the installed commit/image digest, available release tag, publication time, release notes, and whether a compatible image is available. The backend reads the public release feed and immutable tagged notes without a GitHub credential, then caches them for 15 minutes. Applying a release uses a reviewed image digest and a separate host service with a stopped-state snapshot and rollback path. The stock `scripts/install.sh` downloads upstream Runtipi and must not be presented as an Orbis updater.

The upstream Runtipi CLI `start` and `update` paths also pull and run the upstream core without Orbis's Compose override. A production Orbis install must have an Orbis-owned host controller before these commands are retired; a staged override alone is not durable across stock CLI operations.

The host command `scripts/orbis-host-update.py` handles a digest-pinned core update on an already enrolled CLI v4.10.1 installation. It verifies the published release, takes a stopped-state checksum snapshot, and rolls back on a failed start. A restricted Unix socket host service and authenticated operator API expose a reviewed plan, apply, job status, and interrupted recovery. The socket mount, systemd supervision, full VM restart, and browser-clicked updates through beta 12 passed on synthetic arm64 data. A first-install setup tool validates the enrolled core and mount before installing root-owned helper scripts and a systemd unit. A separate in-place helper upgrade passed success, injected-failure rollback, and recovery checks on that VM. This is still a preview without a real-data rehearsal. A GitHub tag alone does not mean a tested image can be installed.

## Host operating system updates

The Orbis Docker container cannot safely update the host through a general-purpose terminal or unrestricted Docker socket API. A small, separately installed host service is required. It should expose only typed operations such as list available packages, read package changelogs, stage updates, apply approved updates, read progress, and request a reboot. All mutating operations require an authenticated administrator, same-origin request protection, explicit target and package list, audit entries, and a confirmation that explains service disruption. The helper must support the host's actual package manager and reboot semantics; Hades's distribution and update method need live inventory before an adapter is chosen.

The browser should display each package's repository, installed and candidate versions, security classification when supplied by the package manager, changelog source, download size when known, reboot requirement, and a timestamp for the last successful check. Unavailable changelogs and failed checks must be labelled. Never run an opaque `curl | sh` or arbitrary browser-supplied command as an update action.

For the later multi-homelab design, the paired host agent can provide this same restricted update interface per server. The controller must show which host an update will affect and retain per-host progress and rollback records.

## Current status

The current fork preserves the existing Runtipi app update mechanisms. Its Update Center links available app updates to their real detail flows and reads public Orbis release notes through the authenticated backend. Host commands cover both a guarded first stock v4.10.1 cutover and an enrolled Orbis update on a self-contained synthetic installation. The Unix socket bridge stays unavailable in the UI unless the helper is connected and the enrolled image is healthy. Browser-clicked updates through beta 12 passed in the isolated VM with exact published digests and verified previous-tree snapshots. Real homelab data and external mounts remain unvalidated. Host operating system updates are still unimplemented.

The tag workflow builds `ghcr.io/twentylines/orbis` for amd64 and arm64, records the immutable image digest in `release-manifest.json`, and publishes notes from the matching `releases/<tag>.md` file. Repository CI and integration tests run first. Prereleases through `v0.1.0-beta.12` have public GHCR images and attached digest manifests. The release checker verifies the published asset, Git tag commit, exact GHCR image-index bytes, and both supported platforms; it can use the Git transport when the anonymous GitHub API quota is exhausted. The browser reads the installed version, commit, and digest from the running container. The adoption transaction took a synthetic stock installation to beta 7, then restored stock after an injected post-start failure. Subsequent host updates reached beta 12, including three browser-clicked transactions. Exact procedures and evidence are in [DEPLOYMENT.md](DEPLOYMENT.md); real-data migration, external-data handling, amd64 runtime, and a production-approved installer remain outstanding.
