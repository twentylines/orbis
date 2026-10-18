# Dependency security work

Checked GitHub's open dependency alerts on 18 October 2026. This record covers the listed advisories, not a complete security audit.

| Package | Advisory | Current work |
| --- | --- | --- |
| Drizzle ORM, root/backend | [Quoted identifier escaping](https://github.com/advisories/GHSA-gpj5-g38j-94v9) | Minimum manifest version raised to 0.45.2; the frozen lock resolves 0.45.4 in both workspaces. Included in published beta37; reviewed isolated OTA, existing record reads, exact data preservation and fresh password login pass. |
| `@hey-api/openapi-ts`, root/frontend | [Generated parameter prototype substitution](https://github.com/advisories/GHSA-hhx9-57xq-r5rw) | Upgraded to 0.97.3 in both workspaces and the complete client regenerated. Null-prototype parameter slots reject prototype substitution. Published beta38 passes reviewed OTA, actual API reads and real rejected-password/retry. |
| `i18next-http-backend`, frontend | [Language URL validation](https://github.com/advisories/GHSA-xvq9-wjp8-hwqf) | Minimum raised to 4.0.2; the frozen lock resolves 4.0.3. Normal translation fetch and rejection of scheme/protocol-relative/traversal inputs pass. Included in beta38; released Login loads translated feedback and preserves retry after HTTP400. |

The ORM change passes 420 existing backend tests, seven frozen runtime packaging cases, two new PostgreSQL identifier/alias escaping checks, backend types and the backend bundle. A frozen Bun install succeeds. The lock update preserves unrelated package resolutions. These tests do not establish production exploitability or complete deployment acceptance.

Beta36 is the UI iteration preceding this dependency change. Its image is independently pinned to its own source; the ORM update is now included and verified in beta37 on the isolated arm64 stack. Hades has not been changed.

## Generated client and translation loader

The generator update replaces all copied runtime templates; it is not just a development-package bump. All 81 SDK exports and 81 route definitions remain present. A second generation produces the same 17 files byte for byte. The generator now uses its own formatting because repository lint deliberately excludes generated clients; invoking the formatter on that excluded directory failed and is no longer configured.

Eleven retained Bun checks cover legitimate parameter values and attempted prototype substitution in all four slots, empty array bodies, encoded app identifiers, credential forwarding, login JSON/response data, normal translation fetch and five unsafe language/namespace values. The tests use controlled transports and make no network requests. They are included in CI. Frontend types and bundle pass after the frozen install. The native source route run passes at 1440/768/390/320px with 108 captures and no browser errors. Released-image checks are recorded separately.

The complete flag audit confirms 312 required positive flags true and 36 expected overflow/background-gap flags false. A separate anonymous 390px Login smoke loads its translation and labelled blank fields/actions without submission. [Source captures and assertions](screenshots/dependency-client/README.md) record that scope.

A source review caught a changed generator default: response-interceptor and transport exceptions can be returned as result data. The shared app client now explicitly rejects errors, preserving existing direct callers, and its configuration is imported by both the app and regression tests. The eleven tests include real configured-client HTTP and transport rejection.

GitHub reported zero open dependency alerts after main commit `3a370472` on 18 October 2026. That is a repository advisory count, not deployed-image acceptance or a complete security audit.

The final configured-client source smoke passes a 390px invalid-login/retry flow with translated themed feedback, retained fields and no false navigation on HTTP 400. Its second synthetic success reaches Home with fixture data. Both POSTs remain browser-intercepted; no real account writes occur.

Published beta38 now passes a real rejected-password/retry against the isolated account, exact reviewed OTA and stopped snapshot/data comparisons. The bounded 16-view released-client inspection uses actual API records and loads all visible images with no page errors or real writes. Original session, preferences, installed/full app and store records match. Manual visual findings remain explicit in the [released gallery](screenshots/live-beta38/README.md); these dependency checks do not claim complete UI or production acceptance. The existing full theme proof applies to its byte-identical shared stylesheets rather than an unnecessary repeated matrix.
