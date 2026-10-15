# Runtipi functionality retained by the fork

Base: Runtipi v4.10.1, commit `5734817389df55aafb9afd571e42e12ab7e647e0`. This inventory was taken from the checked-out routes, frontend components, backend modules, Compose files, and tests. It is a preservation checklist for the redesign, not a claim that migration has been tested on Hades.

| Capability | Existing implementation | Current fork treatment |
| --- | --- | --- |
| Login, registration, reset, TOTP, sessions, forward auth | `modules/auth`, `components/routes`, auth pages | Existing API and guards retained; login surface restyled |
| Official and custom app stores | `modules/app-stores`, `modules/marketplace`, app-store page | Existing search, filters, store selection, refresh, metadata and compatibility retained; catalogue layout restyled |
| Dynamic install and update forms | `modules/app/components/install-form`, `app-update-page`, generated client | Existing forms and handlers retained |
| App start, stop, restart, install, update, reset, uninstall | `modules/app-lifecycle`, `app-actions` and confirmation dialogs | Existing actions and confirmations retained |
| App backups, restore, logs and user Compose overrides | `modules/backups`, `modules/user-config`, app detail tabs | Existing tabs and endpoints retained |
| Custom apps and external links | `modules/custom-apps`, `modules/links`, relevant pages | Existing create/edit and link flows retained |
| General settings, security, stores and logs | `modules/settings`, `app.controller`, app-store service | Existing settings tabs retained; appearance tab added |
| Guest dashboard and certificates | `guest-dashboard`, `GuestHeader`, system controller | Existing guest route and certificate behavior retained |
| Traefik, HTTPS and networking | Compose, network module, Docker builders | No backend rewrite; requires isolated integration testing |
| Queue and event stream | `modules/queue`, `core/sse`, frontend SSE provider | Existing transport retained; persistent lifecycle task history added under `modules/tasks` |
| System load | `modules/system` | Existing load endpoint retained; authenticated current telemetry endpoint added |

## Verification needed before replacement

- Exercise every lifecycle action on disposable apps, including cancellation/error states.
- Check official and custom store refresh and architecture filtering against the current catalogue.
- Compare installed app identities, user config, app-data mount paths, database schema, and external networks on a *copy* of Hades data.
- Test backup and restore, login/TOTP/forward auth, guest access, Traefik routing, and HTTPS in an isolated Linux Docker environment.
- Verify rollback to stock Runtipi using saved image, installation tree, database volume, and external mounts.
