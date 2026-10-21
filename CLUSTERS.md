# Server clusters

A cluster has one admin server and up to 12 member servers. Apps and their data remain on the host where they run. The admin server collects status and app inventories, and sends signed update requests to members. Member servers cannot issue commands to the admin or to one another.

## Pair a server

1. Install a cluster-capable Orbis build on both hosts. Existing Runtipi installations need to be migrated first.
2. On the control host, open **Settings → Cluster**, name the group and create it. This host becomes the admin server.
3. On the joining host, open **Settings → Cluster** and generate a pairing code. Codes expire after five minutes and can be used once.
4. On the admin server, enter the joining host's address and code. Give it a recognizable name.

Use HTTPS with a certificate the admin server trusts. HTTP requires explicit consent and is restricted to private LAN or VPN addresses. Pairing supports RFC 1918 IPv4, the 100.64.0.0/10 shared address space used by private VPNs, and IPv6 unique local addresses. Loopback, link-local, public and IPv4-mapped IPv6 targets are refused. DNS resolution is pinned for each connection; redirects are refused.

The server switcher appears beside logout once another server is paired. Its rack selector offers individual servers and a merged dashboard. Monitor switches all readings and histories to the chosen server. The merged Applications view labels apps by server and launches their actual server address. Desktop launchers retain separate identities for identical apps on different hosts; phones use ordinary links.

## Updates

**Update all apps** queues available, non-ignored app updates with backups on reachable servers. Results distinguish queued requests from failures; a queued request is not a completed update. Use each server's task history to inspect completion.

Orbis updates have their own changelogs and review step. Each host must have a connected, enrolled host service and a healthy matching installation. Review creates a separate snapshot plan per eligible host. **Update all Orbis** applies only those reviewed plans, with member requests first and the admin request last. The admin is skipped if a member request fails. A lost connection does not prove failure: inspect the host's update job before retrying.

Host operating-system packages retain their separate local update workflow. Pairing does not grant arbitrary shell execution or access to another host's Docker socket.

## Permissions and recovery

Cluster setup, pairing, removal and update commands require an operator browser session on the admin server. A joining host must also be authorized locally before it can produce a code. Paired requests use distinct per-member secrets, signed bodies, short timestamp windows and persistent replay protection. Codes and secrets are never included in the dashboard response. The private configuration is `state/cluster.json` in the Orbis data directory; include it in private backups and never publish it.

Remove a member from the admin server while it is reachable. Removal revokes trust on the member before deleting the admin's record. An offline revocation fails visibly and can be retried. The recovery option **Forget unreachable server** deletes only the admin's record; leave the cluster locally on that member to revoke its saved trust as well. Local host accounts remain available for recovery and are not shared across the cluster.

Pairing does not move workloads, merge storage or make applications highly available. Remote app settings, installation and detected-container uninstall open the host's own dashboard; they are not silently applied to the admin server. Keep the admin reachable to use merged views. Each member continues running its existing apps if the admin is offline.
