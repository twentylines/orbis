# Orbis host service

The host service connects Orbis to its Linux host for system readings, reviewed Orbis updates, package updates and server restarts. It runs separately from the Orbis container and accepts fixed requests over a private Unix socket.

**Orbis and the host service update separately.** A newer Orbis interface can connect to an older host service, but features added since that service was installed remain unavailable. Updates → System explains which capabilities need a host service upgrade.

## Requirements

- Linux with systemd, Python 3.10 or newer, Docker with Compose, `rsync` and `git`.
- An enrolled Orbis installation running its published, digest-pinned image.
- A private `/run/orbis` directory mounted read-only into the Orbis core, with `ORBIS_HOST_SOCKET` set to `/run/orbis/host.sock` in that core's configuration.
- An operator account for update, package and restart actions.

Host package management currently supports **Ubuntu 24.04 only** and requires `python3-apt`. Other supported readings remain available when package management is unavailable. Drive health additionally requires `smartmontools` on the host.

Use the [guided installation process](INSTALLATION.md) for a new installation or Runtipi adoption. The manual commands below assume enrollment and the socket mount already exist. Changing Compose files after enrollment invalidates their saved fingerprint; do not edit them to bypass a failed check.

## Install the host service

Use a reviewed checkout of the release you intend to install. Run these commands on the Linux Docker host, from that checkout. Replace `ROOT` with the canonical absolute installation directory and `CONTEXT` with its Docker context name. Use the same values in both commands.

```sh
python3 scripts/orbis-host-service-setup.py plan ROOT --docker-context CONTEXT
sudo python3 scripts/orbis-host-service-setup.py install ROOT --docker-context CONTEXT --confirm-root ROOT
```

The plan checks enrollment, the running image, Compose configuration and the live host/container socket mount. Installation creates root-owned helper files and the `orbis-host.service` systemd unit, then verifies access from both the host and the Orbis core. It refuses to replace an existing helper installation.

The socket mount belongs only in the Orbis core. Never expose it through a public port or mount it into application containers. Keep service state, snapshots and configuration private.

## Upgrade an installed helper

Updating the Orbis container does not replace the host files under `/opt/orbis/host-service`. Use the helper upgrade command from a reviewed checkout of the required release:

```sh
python3 scripts/orbis-host-service-upgrade.py plan ROOT --docker-context CONTEXT
sudo python3 scripts/orbis-host-service-upgrade.py upgrade ROOT --docker-context CONTEXT --confirm-root ROOT
```

Review the plan before applying it. It verifies the existing installation, root ownership, systemd unit, enrollment and live socket mount. It also checks for unresolved core, package or restart operations. The plan reports the installed and candidate file hashes.

The upgrade replaces helper scripts and the systemd unit, restarts only the host service and verifies the host/core connection. It leaves the Orbis container, application containers, installation data and existing helper configuration in place. Identical source hashes require no restart. The transaction keeps the previous helper until replacement verification succeeds and restores it if activation fails.

If an upgrade is interrupted, keep its checkout and recovery files. Recover with the same installation root and Docker context:

```sh
sudo python3 scripts/orbis-host-service-upgrade.py recover ROOT --docker-context CONTEXT --confirm-root ROOT
```

Do not remove a maintenance record or transaction lock to force another update. Inspect a failed recovery locally before continuing.

## System updates and restarts

In **Updates → System**, **Check for updates** refreshes the host's package indexes. Orbis then reads available upgrade candidates from those indexes. Viewing the page alone does not refresh indexes or install packages.

Select packages and review their proposed versions and dependencies before applying them. The host service accepts trusted installed upgrade candidates, pins their versions and repeats its dependency simulation before starting installation. Its systemd worker continues if the browser closes or the Orbis container restarts.

Package reviews expire after 15 minutes. Their creation and expiry timestamps use Unix seconds. Orbis requires a fresh review after expiry or a failed attempt, and dismisses pending reviews when you change the selection or update category.

Package installation may restart services. It does not remove packages, automatically reboot the host or provide automatic package rollback. A failed or interrupted installation blocks conflicting host operations until the package state is inspected and repaired. The System page shows its terminal output. A failed package-list refresh can be retried once its worker has stopped.

**Restart server** first opens a confirmation. The service checks for conflicting operations before requesting a restart. Applications become unavailable during the restart; the page reloads automatically when Orbis returns.

## Drive health

Monitor → Drive health reads supported SMART and NVMe data through `smartctl`. Install `smartmontools` through your host's normal package-management process if it is missing, then refresh the section.

The service collects readings on demand and caches them for one minute. It uses standby-aware reads where the device supports power detection. Sleeping, unsupported or inaccessible disks retain an explicit unavailable state. Some RAID controllers, USB bridges and manufacturer-specific attributes need additional support; a missing reading is never a healthy result.

Orbis shows available health warnings, temperatures, lifetime counters, device-reported test results and a bounded local history. Short and extended self-tests require an operator's explicit confirmation. A test can wake a disk and affect I/O performance. Keep an independent backup; a passing SMART result cannot guarantee that a drive will not fail.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Host service update needed | Upgrade the helper from the matching reviewed release. Updating only the web container does not add host capabilities. |
| Host service disconnected | Check `systemctl status orbis-host.service` on the host and verify its private socket mount. |
| Stale socket mount | Review the enrolled Compose model before recreating only the Orbis core. Do not replace `/run/orbis` underneath a running bind mount. |
| Missing installed-release manifest | Upgrade the helper so it can verify the installed digest and local image labels. Preserve the original release identity. |
| Package download or refresh failure | Read the System page's job output. Check repository connectivity and package-manager state locally before retrying. |
| Drive health unavailable | Check helper support, `smartmontools` availability and device/controller support. |

Keep raw logs and configuration private. Remove credentials, tokens, cookies and personal paths before sharing diagnostic information.
