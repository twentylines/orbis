# Responsive navigation and Settings alignment

Current compiled-source Chrome fixture captures. API responses are intercepted locally; these are not released-image or real homelab evidence.

- [Tablet Settings crop](tablet-settings.png): the supplied gutter/divider defects corrected at 768px.
- [Phone Settings](phone-settings.png) and [App Stores](phone-app-stores.png): ordinary pages with no window controls.
- [Enlarged phone tabs](phone-enlarged-tabs.png) and [320px tabs](narrow-enlarged-tabs.png): complete labels and a divider below every row.
- [4K enlarged Settings](wide-enlarged-settings.png): centered content and aligned title icon.
- [Short-screen light focus](short-light-keyboard-focus.png) and [dark focus](short-dark-keyboard-focus.png): native reverse Tab at 320×400 with doubled text, clear of the sticky bar and dock. Captures retain the actual scroll position.

The [alignment report](alignment-report.json) records 20 native/doubled, light/dark Settings groups across 320–3840px: 0px shared gutter differences, at most 0.008px heading center difference and 12.5px divider clearance. The full route and app-store verification is recorded in [VISUAL-QA.md](../../VISUAL-QA.md).

Desktop windows require at least 1100×640px. Smaller viewports use pages; resizing preserves the mounted form and saved desktop placement. Published beta32 predates this behavior. The phone window captures in [focused-tools](../focused-tools/README.md) are historical.
