# Apps and Store spacing

Compiled source inspected in Chrome at 1440/768/390/320px, light and dark, native and doubled rendered text: **32 compositions, 74 captures, zero page errors or app/account/host mutations**. Data, icons and long copy are controlled synthetic fixtures. This is separate from published-image and physical-device verification.

[Sanitized measurements and source hashes](assertions.json)

- [Desktop light Apps](desktop-tiles-light-text1-apps.png)
- [Desktop dark Apps](desktop-tiles-dark-text1-apps.png)
- [Desktop enlarged Apps](desktop-tiles-light-text2-apps.png)
- [Desktop dark Store](desktop-tiles-dark-text1-store.png)
- [Tablet enlarged Apps](tablet-tiles-dark-text2-apps.png)
- [Phone Store](mobile-tiles-light-text1-store.png)
- [320px enlarged custom link after native scroll](narrow-tiles-light-text2-apps-custom-link-native-scroll.png)
- [320px enlarged Store keyboard focus](narrow-tiles-dark-text2-store-filter-focus.png)

The retained gate compares every painted row and wrapper, title/card/filter gutters, full names/descriptions, loaded icons, text clearance, actual hyphenation, health-label ink baselines and native filter Tab order. It rejects the earlier extra filter inset, alternating tablet offsets, shorter action-card paint, overflowing custom links, orphan letters and enlarged health-baseline drift. Earlier published beta38 findings remain recorded in their own gallery.

Capture positions preserve normal document/internal scroll and keyboard focus; they are not reset for screenshots. Doubled rendered text changes font sizes and line heights while preserving the CSS viewport and root geometry; it is not native browser text zoom. Other browsers, physical devices and full product acceptance remain open.

```sh
ORBIS_VISUAL_TILES_ONLY=1 node scripts/visual-qa.cjs
```

Run against a compiled local preview on port8080. The top/titlebar material is inherited from the separately verified rim-free glass correction; this Apps/Store pass does not repeat all48 status/preset compositions.
