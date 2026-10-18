# Published beta 29

Captured on the isolated arm64 server after real browser OTA from beta 28. Exact image: `ghcr.io/twentylines/orbis@sha256:84a8502cb31c56563af6df6353765581613808a1e6aa78d9aaac7d0353402905`, source `1697920a0fe14ccea2cc791cc26b6d06244eee12`.

HTML, scripts, styles and system/container reads come from that published server. Application names, versions, descriptions and review diffs are controlled test responses. Appearance changes stay inside the browser fixture; the actual app record and server preferences remained unchanged. The complete 60-composition matrix passed 1440/390/320px, both modes, native/doubled text, without browser errors or real API writes.

- [Desktop update](1440-light-update-text-1-information.png)
- [Phone app details](390-dark-update-text-1-app-detail.png)
- [320px update](320-light-update-text-1-information.png)
- [320px enlarged app details](320-dark-update-text-2-app-detail.png)
- [320px enlarged backup step](320-dark-update-text-2-backup.png)
- [Desktop enlarged configuration review](1440-dark-update-text-2-configuration.png)

Full-page screenshots preserve the fixed dock at its viewport position. `DEPLOYMENT.md` records the verified image, retained records and snapshot; [release notes](https://github.com/twentylines/orbis/releases) records source checks and limits. Hades was not accessed.
