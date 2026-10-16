# Released beta 32 network recovery

These 390×844 dark-mode captures use the exact published beta32 image and real authenticated store requests on the isolated arm64 synthetic installation. Appearance responses were fulfilled only inside the browser. Root deliberately paused and resumed the exact owned Git fixture; no application container was started or paused.

| Capture | Actual checked behavior |
| --- | --- |
| [Complete clone](healthy-clone-complete.png) | HTTP201; exact fixture HEAD, complete one-app catalogue and native Git fsck; the app-free store was then removed with HTTP200 |
| [Pending enable](selective-enable-pending-390.png) | Real request waits on the paused Git fixture; inputs and submit remain disabled |
| [Network timeout](selective-enable-timeout-390.png) | HTTP502 after 30,047.70 ms; database row stays disabled, previous cache/data remain intact, same dialog retains entered values and a translated themed inline error |
| [Retry succeeds](selective-enable-retry-success-390.png) | Root resumes Git; Save in the same mounted dialog returns HTTP200 and restores the original state |

There were no browser errors or success notices for the failed request. The retained error and pending surfaces were also inspected directly for padding, alignment and readable whole labels. Broader source UI matrices remain separate evidence in [VISUAL-QA.md](../../VISUAL-QA.md).

The post-operation Settings captures also expose a separate layout defect: its window header can pass behind the sticky system bar during page scrolling. That remains open in this released image; the passed modal recovery checks do not establish a correct scrolled tool layout.

Root restored native Compose and removed the temporary GitHub hostname override. All nine baseline categories matched: stores, installed list, full app records, catalogues, repository HEADs, native app-container identity/state, protected files, preferences and tasks. Both temporary store/cache and clone staging were gone. Git was running and unpaused; the default Docker context stayed `default`.

[Sanitized evidence](evidence.json) includes the actual timeout, UI assertions, baseline comparisons and reviewed OTA result. It contains no sessions, credentials, file contents or private baseline. [Deployment evidence](../../DEPLOYMENT.md) records release and snapshot identities. Private reports, the root coordinator and rollback snapshots remain outside Git. Internal Git pull counts were not measured.

This does not establish beta32 AMD64 boot, copied real-data migration, additional store hosts, external storage/HTTPS or full production acceptance. Hades was not accessed.
