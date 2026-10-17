# Dependency security work

Checked GitHub's open dependency alerts on 18 October 2026. This record covers the listed advisories, not a complete security audit.

| Package | Advisory | Current work |
| --- | --- | --- |
| Drizzle ORM, root/backend | [Quoted identifier escaping](https://github.com/advisories/GHSA-gpj5-g38j-94v9) | Minimum manifest version raised to 0.45.2; the frozen lock resolves 0.45.4 in both workspaces. Source verification passes; released-image verification remains pending. |
| `@hey-api/openapi-ts`, root/frontend | [Generated parameter prototype substitution](https://github.com/advisories/GHSA-hhx9-57xq-r5rw) | Open. Upgrade to at least 0.97.3 and regenerate/check the client templates; changing the generator version alone does not replace copied runtime code. |
| `i18next-http-backend`, frontend | [Language URL validation](https://github.com/advisories/GHSA-xvq9-wjp8-hwqf) | Open. Upgrade to at least 4.0.2 and check normal translation loading and rejected URL input. |

The ORM change passes 420 existing backend tests, seven frozen runtime packaging cases, two new PostgreSQL identifier/alias escaping checks, backend types and the backend bundle. A frozen Bun install succeeds. The lock update preserves unrelated package resolutions. These tests do not establish production exploitability or complete deployment acceptance.

Beta36 is the UI iteration preceding this dependency change. Its image is independently pinned to its own source; the source ORM update must be included in a subsequent image before this item is considered deployed. Hades has not been changed.
