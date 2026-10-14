# Orbis multi-homelab phase

This is a future phase requested after the single-server fork is working and its Runtipi migration is rehearsed. It is a design record, not an implemented feature.

## Onboarding and roles

- During first-run onboarding, offer **Run this server as the controller** or **Use this server on its own**. A standalone installation can enable controller mode later.
- A controller retains its own full Runtipi installation and can pair additional Runtipi-fork servers through a small companion agent on each remote server. The agent is installed locally on the remote host and uses that host's existing Runtipi lifecycle services; it is not a second catalogue or a generic remote shell.
- Pairing uses an expiring one-time code, explicit approval on both servers, and mutually authenticated, rotatable credentials. The controller can revoke a server. Agents initiate outbound connections where possible so pairing does not require exposing a Docker socket or a new inbound port.
- Each server keeps its own database, app data, secrets, reverse proxy, DNS, and backups. The controller stores only the metadata needed to identify and operate a paired server. No automatic cross-server copying of app data is implied.

## Merged experience

- The workspace combines applications and status from paired servers, with a persistent server label on every app and task. Filtering by server remains available everywhere.
- Before installation, the UI requires an explicit target server and shows that server's architecture, app compatibility, free space, and configuration form returned by its Runtipi backend. The request is authorized on the target and runs through its existing queue and lifecycle handlers.
- Launching an app opens its configured URL on its home server. The controller does not rewrite URLs or proxy credentials to make an app appear local.
- The task centre preserves the target server, action, timestamps, progress/events, errors, and link to the target's actual logs. A disconnected server shows its last confirmed state and sample time; it never appears healthy because the controller is online.
- The monitor has a compact one-server view and a multi-server overview. A 3D breakdown may be an optional visual view with a text/table equivalent. It must use measured telemetry only and remain readable with reduced motion and low effects enabled.

## Authority and efficiency

- Define a narrow, versioned protocol for read-only inventory/telemetry and specific lifecycle commands. Reject unknown commands and mismatched protocol versions. The agent never accepts arbitrary browser-supplied shell commands, filesystem paths, Compose text, or Docker socket access.
- Every command carries an authenticated actor, target server, action, app identity, idempotency key, and expiry. The target checks authorization and records the outcome. Destructive operations still require a target-aware confirmation.
- Keep local Runtipi operation independent of controller availability. Queue remote commands only when their safe replay semantics are defined; do not replay an old uninstall or reset after reconnect.
- Use one connection per paired server with bounded message sizes, heartbeats, exponential reconnect, and backpressure. Poll slow sensors less often than lightweight status. Share telemetry subscriptions across browser clients; downsample and cap retained history. Suspend nonessential animation and browser refresh in background tabs.
- Load the 3D view only when opened, use a small static geometry budget, avoid continuous full-screen effects, and provide a lightweight 2D fallback. The interface should remain useful on a server with limited CPU and memory.

## Acceptance before implementation

The single-server fork must first pass its own Docker lifecycle, backup/restore, and copied-data migration tests. Then test pairing with at least two isolated Docker hosts, a disconnected agent, credential rotation/revocation, incompatible architecture, delayed/duplicate commands, target-aware install and launch, and a controller restart. Hades must not be used as the first pairing test host.
