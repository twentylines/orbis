# Updates

Open **Updates** from the dock, or choose **Open Update Center** in Settings. Application, Orbis and host operating system updates are separate operations.

## Orbis

The Orbis card shows the installed release, the available release and its expanded changelog. Select **Update** to verify the published image, check backup storage and start the update. Progress reports the current host operation. Keep the page open to follow it, or return later to check the recorded job.

The host service verifies the release tag, source commit and immutable image digest. Releases using the current installation protocol back up control storage and pause only Orbis control services; installed app containers and their data remain live. A failed start restores the verified control backup. Unknown storage writers or changed ownership still block the operation. Older release protocols retain their original requirement for stopped apps.

Core updates require an authenticated operator, a healthy enrolled image and the Orbis host service. If an older installation cannot start an update from the browser, rerun the current installer on that server:

```sh
curl -fsSL https://twentylines.github.io/orbis/install | sudo python3
```

For an existing Orbis installation, this upgrades the host helper and updates Orbis automatically. It retains accounts, settings and apps. An already current release is reported as up to date; an older pinned installer cannot downgrade it. See [installation requirements](INSTALLATION.md) and [host service setup and recovery](HOST-SERVICE.md).

Before the first approved Stable release, use the installer attached to the selected Nightly release to upgrade its host helper. The default endpoint keeps the last verified legacy installer until Stable is available; it does not silently enrol servers in Nightly.

An interrupted update must be inspected or recovered before another update starts. A request timing out does not mean the update stopped; check the recorded job before trying again. Keep the server's private backup and recovery journals until the updated server is healthy. The upstream Runtipi installer and CLI update command do not apply the Orbis release protocol.

### Release channels

Settings shows the server's **Stable** or **Nightly** channel. Stable receives final releases. Nightly also receives beta and release-candidate builds, which may contain unfinished features or regressions. Selecting Nightly opens a warning and requires confirmation; it does not immediately install an update. Channel changes require an operator and a current host service.

To leave Nightly while running a prerelease, choose **Review stable install**. Orbis reviews the latest Stable release and asks for confirmation before installing it. The channel changes only after that release is healthy. Cancelling or a failed installation keeps Nightly selected. Runtipi and data compatibility checks still apply. A server already running a final release can switch channels without reinstalling it.

The downgrade list on Stable contains final releases only. On Nightly, it also contains older beta or release-candidate builds of the currently installed version, but never prereleases of an earlier version. For example, `1.2.0 beta 3` can offer `1.2.0 beta 2` and older final releases, but not `1.1.0 beta 4`.

A Nightly installer asks for the same risk acknowledgement. Unattended installation requires `--accept-nightly` in addition to the usual installation options. Nightly updates and returning to Stable require the host service.

### Critical security updates

A release explicitly marked critical shows a red **Critical update** action and a caution message above its changelog. This applies to both channels and does not enable automatic updates, change channels or skip verification. Release maintainers mark an urgent security release with `<!-- orbis-update-priority: critical -->` at the start of its release notes, before the changelog; ordinary releases omit it. The release manifest records the same priority.

## Applications

Available app updates use each app's configured store and existing installation identity. Open an app update to review its configuration and store release notes, or choose **Update all** to update the available apps. The interface reports when a store supplies no changelog. Refreshing app stores does not update Orbis.

In a cluster, Orbis releases are listed separately by server. **Update all Orbis** updates member servers before the admin server and stops on a failed member acknowledgement. **Update all apps** is a separate action.

## Host operating system

Host package updates currently support **Ubuntu 24.04** with APT and `python3-apt`. The Host operating system card lists available packages, installed and candidate versions, source repositories, security classifications, download sizes, package-list age and distribution changelogs when available.

1. Select the packages to update.
2. Choose **Review selected updates**. Orbis checks the APT transaction and lists every upgrade and new dependency.
3. Choose **Install reviewed packages** to install that exact transaction.

A live terminal shows APT output while installation runs. Scroll or use the keyboard to read earlier output; **Follow output** returns to the latest lines. Output is a bounded, sanitised tail of the private package job log, available only to operators. The detached host worker continues when the page closes.

The helper accepts trusted installed upgrade candidates, pins exact versions and rejects package removals or changed plans. Services may restart during package installation. APT changes have no automatic rollback; retain an independent host backup. Failed or interrupted jobs require local inspection before another package or core update.

Repository refresh and server restarts require an up-to-date host service. A restart needs a separate review and confirmation. Failed or interrupted package operations require inspection before continuing.
