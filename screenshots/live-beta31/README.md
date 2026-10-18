# Released beta 31 recovery checks

These 390×844 dark-mode captures use the exact published beta31 image and real authenticated store requests on the isolated arm64 synthetic installation. Appearance reads/writes were fulfilled only inside the browser. The offline fixture and read-only repository bind were deliberate test faults.

| Capture | Actual response and checked behavior |
| --- | --- |
| [Duplicate URL](duplicate-URL.png) | HTTP409; values and Add dialog retained |
| [Duplicate slug](duplicate-slug.png) | HTTP409; values and Add dialog retained |
| [Invalid clone](invalid-first-clone.png) | HTTP400; no published partial repository; corrected URL retries in the same dialog with HTTP201 |
| [Offline enable](selective-enable-offline-error.png) | HTTP502; original store remains disabled; restarted Git fixture permits HTTP200 retry in the same dialog |
| [Installed store](installed-store-delete-rejected.png) | HTTP400; installed apps and store retained |
| [Read-only removal](readonly-repo-delete-error.png) | HTTP500; row/cache retained and inline error shown; removing the exact app-free read-only bind permits HTTP200 retry in the same dialog |

All six rejection views retained themed inline errors and usable retry controls, without a success notice or browser error. Root then restored native Compose and confirmed exact baseline equality for all eight categories: stores, installed list, full app records, catalogues, repository HEADs, protected files, preferences and terminal tasks. Both temporary overrides and the app-free test store/cache were removed. The fixture Git server remained running and the default Docker context stayed `default`.

[Sanitized assertions](evidence.json) contain no sessions, credentials, file contents or private baseline. Full reports and the stopped-tree rollback snapshot remain private. [Deployment evidence](../../DEPLOYMENT.md) records exact release and snapshot identities. Source fixtures at native/enlarged text and other widths are separate evidence in [Release notes](https://github.com/twentylines/orbis/releases).

This does not establish copied real-data, stalled-network, external storage/HTTPS or full production acceptance. Hades was not accessed.
