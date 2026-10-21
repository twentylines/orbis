# App backups

The staged restore and interruption recovery described below require Orbis beta58 or later.

Open **Apps → an app → Backups** to create, upload, download, restore or delete a backup. A backup contains the managed app data, installed app files and user configuration overrides. External bind mounts, Docker named volumes and media outside the app directory require separate backups.

## Uploads

The upload corrections in development builds stream archives to private disk storage, validate their contents and app configuration, then publish the completed file. An existing backup with the same filename is kept; rename the upload to retain both.

Allow enough free space for the incoming archive. App configuration metadata is limited to 1 MiB; this is separate from the app data inside the backup. Partial or invalid uploads do not enter the backup list. Cancelling stops a transfer or validation still in progress; a backup already published is retained. Temporary files left by an interrupted process are removed on the next upload for that app.

Beta58 has a known upload validation and permissions issue. Use backups created by Orbis in that release.

## Restore

Restoring replaces the app's current managed data and overrides. Create a backup first if you need to keep them.

Orbis stops the app, validates the archive and stages the replacement directories before changing the live files. A successful restore updates the installed version in the database. An app that was running starts again; an app that was stopped stays stopped.

Staging needs space for the restored data alongside the current data. Extraction uses the app-data filesystem. Same-filesystem moves avoid a second full copy; data crossing filesystems is copied and checked before replacement. Insufficient space or permissions abort the restore.

## Interrupted restores

Orbis records restore progress under `data/state/app-restores`. It retains the previous directories until the replacement is committed. An interrupted, uncommitted restore rolls back; a committed restore keeps the restored data and finishes database reconciliation and cleanup.

Recovery stops the app's containers and runs before normal startup or another app operation. The app stays stopped after recovery. Start it from Apps after checking its state.

If recovery storage is unavailable, Orbis refuses to continue startup or app operations. Restore access to the storage and restart Orbis. Keep the recovery journal and hidden `.orbis-restore-…` staging directories until recovery completes.

A managed app directory that is itself a mount point, or contains nested mounts, cannot be swapped safely; its restore is refused. Mounting storage above the managed app directories is supported. External-volume migration and direct mount-point restore require a separate recovery procedure.
