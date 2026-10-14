# Orbis changelog

## Unreleased development preview

- Forked Runtipi v4.10.1 while preserving its application and data compatibility surfaces.
- Added the Orbis name, icon, browser metadata, server desktop, command search, App Store presentation, Appearance settings, and a live System Monitor.
- Added authenticated telemetry and per-user desktop preferences.
- Added an Update Center that shows application update availability and reads Orbis release notes from GitHub when releases exist. Host package updates and in-browser Orbis installation are still pending restricted host tooling and rollback validation.
- Verified clean startup, registration, key routes, official catalogue access, and new authenticated endpoints in a disposable Docker VM. Existing-install migration and disposable-app lifecycle are still pending.
- Replaced inherited upstream release jobs with a gated Orbis image and GitHub Release workflow, and added authenticated installed-build metadata to the Update Center. No Orbis release has been published yet.
- Passed a disposable Whoami install, stop, start, restart, backup, reset, restore, and uninstall path. Fixed the default backup list page and removed a tar self-inclusion warning during backup creation.

The first tagged release will be created only after the fork has passed copied-data migration and application lifecycle testing.
