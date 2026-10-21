# Inspect an existing installation

With Python 3.10+ and Docker access, run this from an Orbis source checkout on the Docker host you want to inspect:

```sh
python3 scripts/orbis-install-detect.py --docker-context default
```

Use the appropriate context name if Docker is configured with several hosts. The command does not change your selected context.

The JSON report identifies Runtipi and Orbis controllers, their versions and installation paths. It checks Compose ownership, mounted configuration files, managed app storage, reserved container names and Docker-published ports. External bind mounts, named volumes and temporary storage are listed separately. Apps whose owning installation cannot be established remain unassigned for review. Multiple installations require explicit selection. An existing Orbis controller is reported separately from Runtipi.

The command only reads Docker metadata. It does not read environment values, pull images, stop containers, change files or authorize a replacement. Failed or incomplete Docker inspection returns an error instead of reporting an empty server. Host files and ports used by services outside Docker require a subsequent installation review.

A stopped controller remains discoverable while its container exists. If its containers have been removed, its saved files must be checked when choosing the installation directory; `no-controller-found` does not establish that the directory is empty.

For the existing explicit-root migration tools and their supported layouts, see [Installation and migration](DEPLOYMENT.md).
