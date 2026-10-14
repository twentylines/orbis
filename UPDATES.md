# Orbis Update Center: implementation contract

Orbis will make application, Orbis core, and host operating system updates visible in the browser with the release notes that belong to each update. These are separate operations with different permissions and rollback paths.

## Application updates

Keep Runtipi's installed app identities, store metadata, compatibility checks, generated forms, and existing app update service. The Update Center should reuse the current app version and lifecycle APIs, link to each app's configured store entry, and show the store's supplied release notes when present. It must report when a store provides no changelog. App-store refresh must never replace the Orbis core image.

## Orbis releases

Use GitHub Releases from the Orbis repository as the changelog source. Show the installed commit/image digest, available release tag, publication time, release notes, and whether a compatible image is available. The browser can check releases without credentials for a public repository, but applying a release must use a reviewed image digest and a server-side deployment controller with a backup and rollback path. The stock `scripts/install.sh` downloads upstream Runtipi and must not be presented as an Orbis updater.

Until a release and guarded deployment controller exist, the UI must say that no in-browser core update is available. A GitHub tag alone does not mean that a tested installable image exists.

## Host operating system updates

The Orbis Docker container cannot safely update the host through a general-purpose terminal or unrestricted Docker socket API. A small, separately installed host service is required. It should expose only typed operations such as list available packages, read package changelogs, stage updates, apply approved updates, read progress, and request a reboot. All mutating operations require an authenticated administrator, same-origin request protection, explicit target and package list, audit entries, and a confirmation that explains service disruption. The helper must support the host's actual package manager and reboot semantics; Hades's distribution and update method need live inventory before an adapter is chosen.

The browser should display each package's repository, installed and candidate versions, security classification when supplied by the package manager, changelog source, download size when known, reboot requirement, and a timestamp for the last successful check. Unavailable changelogs and failed checks must be labelled. Never run an opaque `curl | sh` or arbitrary browser-supplied command as an update action.

For the later multi-homelab design, the paired host agent can provide this same restricted update interface per server. The controller must show which host an update will affect and retain per-host progress and rollback records.

## Current status

The current fork preserves the existing Runtipi app update mechanisms. Its Update Center links available app updates to their real detail flows and reads published Orbis release notes directly from GitHub. It does not yet provide an Orbis release installer or host operating system updater. Those controls must not appear as working actions until the helper, packaging, and rollback have passed disposable-host tests.

The tag workflow now builds `ghcr.io/twentylines/orbis` for amd64 and arm64, records the immutable image digest in `release-manifest.json`, and publishes notes from the matching `releases/<tag>.md` file. Repository CI and integration tests run first. No Orbis tag or image has been released yet. The browser reads the installed version and commit from the running container and states when the deployment did not supply an image digest.
