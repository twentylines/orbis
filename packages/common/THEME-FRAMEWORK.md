# Theme framework contract v1

This is an inactive contract foundation. It does not make framework packages installable, enable a renderer or add a catalogue. `themeFrameworkRuntimeAvailable` is `false`. Existing appearance, saved preferences and cosmetic pack loading continue through the existing runtime. No package JavaScript, hooks, CSS, selectors, HTML, remote asset URLs or arbitrary action arguments are accepted.

## Entry points

Import the following modules from `@runtipi/common/schemas/`:

| Module | Public contract |
| --- | --- |
| `theme-framework-contract` | `themeFrameworkDocumentSchema`, inferred `ThemeFrameworkDocument`, structural member schemas and `themeFrameworkJsonSchema()` |
| `theme-framework-registry` | API version, registered components/slots/actions/sound events, viewport constraints, silent bindings and inactive runtime flag |
| `theme-framework-validation` | `validateThemeFrameworkDocument()` and `frameworkSettingAllows()` |
| `theme-framework-compatibility` | Hard host compatibility, installed-version UI support reconciliation/dismissal and gesture-aware sound resolution |
| `theme-framework-resolution` | Pure mode/condition/token/icon resolution and protected core layout projection |
| `theme-framework-adapter` | Host-only lossless legacy presentation adapter |

The manifest discriminator is exactly `schema: "orbis.theme-framework.v1"`. It is distinct from legacy `formatVersion: 1` cosmetic manifests and from `orbis.theme-legacy-adapter.v1` host presentations. One format must never be relabelled to claim another format's capabilities. IDs are lower-case dotted or hyphenated names, maximum 64 characters. Reserved prototype names are forbidden. Package ID `default` and IDs beginning with `orbis-` are reserved to the host; a package cannot impersonate Default.

The generated structural schema is [`packages/common/json-schemas/theme-framework-v1.json`](./json-schemas/theme-framework-v1.json). Regenerate with `bun packages/common/script/gen-theme-framework-schema.ts`; use `--check` to verify it without writing. It is produced from the same ArkType validation schema, using JSON Schema draft 2020-12. It deliberately does not pretend to describe every semantic constraint.

## Validation boundary

Consumers must call `validateThemeFrameworkDocument()` on parsed JSON, before compatibility checks or storage. Success returns a detached document; failure returns bounded issue codes and paths without echoing untrusted text. The validator rejects accessor properties, symbols, non-JSON values, excessive nesting and object graphs exceeding 30,000 inspected values. It rejects unknown fields at every schema object boundary. It does not execute package code.

Structural validation enforces types, enums, field limits, fixed file syntax and closed objects. Semantic validation additionally enforces unique IDs, references, typed defaults and presets, resource totals, visibility/parent cycles, component variants, layout constraints, sound assets and reserved identities. Schema-only acceptance is insufficient for admission.

Asset metadata is not proof of actual bytes. A future package reader must verify exact entry names, regular files, no links, archive limits, actual byte counts, SHA-256, magic/MIME, decoded dimensions and audio duration before exposing local assets. No extraction or package reader is implemented here. Asset descriptors permit only PNG/JPEG/WebP raster images/icons, WOFF2 fonts and MP3/OGG/WAV audio, beneath `assets/`, at most four path segments after that directory. No SVG or fetchable URL is accepted. Maximum 128 assets, 8 MiB each and 64 MiB total; fonts 4 MiB; icons 1 MiB and 1024×1024; raster pixel count 33,554,432; audio duration 30 seconds. The eventual reader must enforce these bounds independently of declarations.

## Stable registry and core behaviour

API version 1 registers shell system bar/navigation/session/workspace, dialog/notification layers, settings recovery, button/dropdown/slider/checkbox/colour controls and dialog/window/notification surfaces. Each has one or two structural variants. Theme documents select registered variants; they cannot invent a component implementation. Missing selections mean the host's standard variant.

Slots are `shell.header`, `shell.primary`, `shell.footer`, `shell.sidebar`, `shell.overlay`, `window.toolbar`, `settings.header`, `settings.content` and `notification.actions`. IDs are semantic integration points, never internal CSS selectors. The registry and its nested registrations are frozen. Future incompatible meanings require a new API version, not reuse of an existing ID.

Registered actions navigate Home/Apps/Store/Monitor/Updates/Settings, log out, close/minimise/maximise a window or dismiss a notification. All are user-gesture bound. Window and notification actions require the matching host-owned context and slot; package data cannot provide object IDs or privilege. Logout retains core-owned confirmation. A renderer must dispatch through core handlers with existing authentication, authorisation, confirmation and state checks; registry membership never grants authority. No actions execute commands, change host configuration or directly reset/restore data.

## Responsive layouts and essential controls

Every document declares exactly one phone, tablet and desktop layout. Contract minimums are 320×480, 620×480 and 1100×640; maximum columns are 1, 8 and 12. The host chooses the actual projection using both dimensions. Desktop launcher/window behaviour must not appear below the desktop minimums. These are validator limits, not proof of actual geometry, zoom or native interaction.

Flat nodes declare a stable ID, slot, parent, order, safe anchor and placement. Flow supports a bounded span; dock supports a registered edge; floating uses percentage bounds. Added group/text/image/action/control nodes use `theme.` IDs. Ordinary text/image/action/control additions are restricted to the primary/settings-content/window-toolbar/notification-actions slots. Groups may use registered slots and carry compatible core instances as well as permitted additions; parent and child share a slot. Groups do not replace protected host layers or permanent escape surfaces. Images require a declared raster asset and alternative text; controls reference a declared setting. Text is plain data, not HTML.

Navigation, session, dialogs, notifications and settings recovery must each appear once in every profile with their exact registered component ID. They and their group ancestors cannot be conditional or non-scrollably clipped. Core nodes may use flow, docking, floating or host placement and may be grouped within registered compatible slots. Layout-mounted core instances retain their core-owned behaviour. Atomic control/surface registrations remain styling classes rather than invented standalone behaviour; action/control nodes use registered actions/settings. The registry records movable instances, allowed slots and minimum sizes.

Every node chooses `viewport.safe` when it is a root, or `parent.content` when grouped. Parent references must target a group in the same slot. Groups select row or column arrangement, allow natural wrapping and have a maximum depth of eight. Minimum dimensions, maximum frame dimensions, content scrolling and viewport bounds constrain resizing. Unsupported slots, unsafe anchors, duplicate ordering, parent cycles, hidden essential ancestry, under-sized interactive constraints and out-of-bounds percentages fail validation.

Dock and float placements explicitly declare `fallback: "flow"`. Float percentages are relative to their safe parent anchor, never the physical screen or an arbitrary CSS containing block. The pure resolver permits floating on roomy desktops when measured content fits without collisions or a scrolling sibling region. Phone layouts, enlarged text, collisions and insufficient space reflow those nodes in declared order. The resolver restarts a parent arrangement when a desktop float must fall back, rather than appending it after later controls. Docking reserves a fixed edge outside the flow scroll region; narrow or enlarged projections reflow docking into document order. Core reordering/resizing/grouping/docking/floating now have executable projection rules, rather than an unconditional host-only restriction.

### Permanent host escape reservations

`frameworkEscapeAnchors` registers `escape.navigation`, `escape.session` and `escape.recovery`, bound respectively to core-owned `navigation.open`, `session.open` and `theme.recover`. The recovery action retains core confirmation and selects Default through core behaviour; it never performs a host reset. A manifest cannot replace or provide these reservations. The projection returns their immutable labelled frames separately from themed nodes, in a permanent `host-escape` layer, with no group parent or condition. They lie outside the theme viewport and every theme scroll/clipping region. The host must render this layer above both theme additions and host overlay content; package data has no z-index or event-handler override.

Escape labels use host-owned system typography, icons and accessible colours; theme font/token/icon overrides do not apply to them. The projection marks their style `host-accessible`. Labels use trusted host localisation and real host text measurement, wrap naturally and preserve minimum touch targets. If the safe viewport cannot contain the escape reservation and a usable content region, the result requests the host fallback. A host must never activate a themed projection after that result, remove these controls because a group is hidden, or place a theme covering surface above them. The fallback itself must remain the host's independently accessible Default surface.

### Pure projection API

`resolveThemeFrameworkLayout(document, values, host)` validates the document, selects a phone/tablet/desktop profile using both dimensions adjusted for host text scale, and resolves conditions/tokens. Host input supplies safe-area insets plus trusted deterministic text and core-content measurement functions. These callbacks are application code, never manifest hooks. Their width argument is the actual available wrapping width; scale includes resolved typography size/scale and host enlargement; family is the validated font-family ID. The future renderer must use the same verified font metrics and actual core content, not estimates or current-state guesses.

The result contains `viewport`, immutable `escapes`, projected `nodes` and per-parent flow `regions`. Root geometry is relative to the returned theme viewport. Each node returns its explicit logical `order`; callers use that order within each parent for the reading/focus sequence. A node with `space: "anchor"` uses its safe parent anchor; a node with `space: "flow-content"` uses its parent's returned flow region and content coordinates. Group child coordinates are local to that group; the group's region includes its visible heading offset. Dock/float frames are outside the flow scroller. A region reports the entire scrollable content height, its bounded visible rectangle, `overflow: "auto"` and focus reveal. Frames can scroll internally when their measured content exceeds the safe frame height; the text/content height is retained and never replaced by an ellipsis or an undersized measurement.

Callers must implement this coordinate/scroll hierarchy exactly. Painting flow-content coordinates directly into the viewport would violate the contract. The host retains word wrapping, logical reading order, keyboard reveal, protected-layer order, accessible targets and non-overlap. Unreflowable words/core content, impossible group headings, oversized content or projection work beyond 8,192 node measurements produce `status: "host-fallback"` with no accepted themed nodes/regions. Existing escape reservations remain available when they were measurable; invalid trusted measurements throw. A fallback result is not successful themed layout support for that input.

The algorithm is renderer-independent. Its synthetic measurement tests do not establish browser font layout, live component integration, focus behaviour, screen-reader order, contrast, animation or native accessibility. Runtime integration must verify these independently before enabling packages.

## Tokens, modes and Customisation

Fixed token fields cover semantic colours, typography, spacing, shape and bounded motion. Registered token IDs are closed semantic paths, not CSS selectors. Fonts reference a built-in family or declared local font asset. `modes` supplies typed token overrides for light, dark and OLED. Resolution starts with base tokens; OLED inherits dark overrides before OLED overrides. Missing mode overrides retain base values.

`tokenRules` contains bounded condition-based assignments for all modes or one explicit mode. Matching rules apply in declaration order. `tokenBindings` binds a registered token to a compatible declared setting using identity or numeric percent conversion. Validation checks the setting's entire allowable numeric range/enum against the target token, not only the current default. No property paths outside the registry, arithmetic expressions, templates or executable transforms are permitted. Explicit zero is applied; null inherits the preceding token value.

`resolveThemeFrameworkTokens(document, values, host)` executes base → mode → matching condition rules → valid dynamic bindings → host accessibility overrides. Host enlargement multiplies the theme typography scale, host reduced motion sets duration to zero, and trusted forced colours replace the entire semantic colour map last. Saved inputs must have unique known keys and allowed typed values; unknown/malformed values fail rather than silently entering another namespace. Conditions read these typed effective values plus defaults. The returned object is detached, and resolution does not save preferences or affect the current runtime.

`icons` maps registered semantic roles to declared raster assets whose kind is exactly `icon`, or to `null` for the core default. Optional conditions and icon-asset settings allow safe declarative selection. `resolveThemeFrameworkIcon()` applies all-mode entries, then requested mode entries (dark before OLED), preserving declaration order within each tier. Null settings inherit the map's asset; a null map requests the core icon. Missing/wrong-kind assets fail validation. Results contain detached verified-declaration metadata or a core role, never a current icon URL, remote fetch, SVG or executable asset. Actual byte verification/loading remains a package-reader responsibility.

Settings are boolean, stepped integer, enum, colour or local asset selection, with typed defaults. Explicit `false`, `0` and `null` retain their meaning. Each setting belongs to exactly one declared section whose ID matches its group. Section/setting visibility uses bounded conjunctions of typed equality comparisons; visibility cannot depend on itself through section or setting cycles. Presets contain unique known keys and allowed values. Host accessibility/recovery controls stay available through `hostControls: "always"`; packages cannot replace them.

Namespace ownership remains the exact theme ID plus its settings version. Do not combine different themes' values or rewrite old IDs. Settings migration and storage transactions are not implemented by this slice; an incompatible settings version requires a separately reviewed migration contract.

## Hard host requirements and soft UI support

`requires.api` is 1. `requires.releases` lists exact supported host releases, including explicit beta/RC releases when applicable. Leading `v` is equivalent; prerelease and stable releases remain distinct. Duplicate canonical releases are invalid. `evaluateThemeFrameworkCompatibility()` reports hard API/release checks separately from the inactive runtime flag. Passing these checks is not installation permission or runtime support.

`supportsUiRevisions` declares numbered host UI revisions supported by the installed document. It is independent of exact release requirements. A host supplies a revision only when an explicit UI change requires theme optimisation; ordinary releases supply `null`. Reconciliation retains unresolved revisions through later ordinary updates. State is bound to the exact theme ID and installed package version, never the latest catalogue metadata. Other themes require separate state; crossing namespaces fails.

Dismissal copies pending revisions into a dismissed set but never clears underlying pending status. A newly marked unsupported UI revision or a changed installed version can show the notice again. Updating the installed theme clears only revisions it declares supported. Future UI must show a small dismissible notice inside Customisation only, without global banners, repeated popups or task badges. This module does not render or persist the notice.

## Sounds

Versioned semantic events cover login/logout, control activation, navigation, notification levels, window actions and dialog open/close. Omitted bindings and built-in adapter bindings are silent. Bindings may select a declared local audio asset or explicitly silence an event; silence requires gain 0. Resolution requires prior host gesture unlock, no host mute and a valid host volume, and multiplies package gain by host volume. It does not play audio or fetch bytes. The future engine must own user gesture/autoplay handling, verified asset loading, mute/volume, privacy/accessibility and rate limiting; packages cannot override them. Login must remain silent until audio has legitimately been unlocked.

## Legacy preservation

`adaptLegacyThemeFramework()` accepts only identities already in the host's reviewed legacy registry. It returns a distinct presentation, never a framework manifest. Stable identity `orbis-builtin@1.0.0` displays as **Default** while the original stored ID, existing descriptor and runtime remain unchanged. Built-in UI support is host-maintained. Legacy cosmetic themes retain their exact IDs/versions and are marked as undeclared for the new UI contract rather than claiming support.

Preferences and the entire existing namespace state are cloned unchanged, including inactive namespaces, explicit null/false/zero and settings versions. No new defaults are merged, no namespace is renamed, and no old theme is installed or activated. The adapter does not change current colour, wallpaper, layout or sound behaviour.

## Remaining integration

Before enabling framework packages: integrate the executable mode/condition/token/icon and protected-layout contracts with accessible core components and a constrained renderer; implement schema-driven Customisation and transactional namespace persistence; verify asset/package admission and rollback/recovery; implement a guarded sound engine; connect hard/soft compatibility at install/apply/update; build the independently refreshed remote catalogue and authoring/publishing documentation; verify native Chromium/Firefox/Safari, mobile and enlarged-text behaviour. No example packs, catalogue submissions, public repository or package publishing is supplied by this contract slice.
