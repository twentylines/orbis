# Focused tool scrolling

Compiled-source Chrome fixture captures from the focused-tool correction after beta32. All API responses are intercepted locally; these are not released-image or real homelab evidence.

- `phone-*-text100-add-focus.png`: native 390×844 Settings with Add focused and the title bar clear of the system bar.
- `short-*-text200-add-focus.png`: 320×400 with doubled text. The whole tool scrolls within the space between the chrome and dock; Add and its focus marker remain reachable.
- `wide-light-text100-focused.png` and `wide-dark-text200-focused.png`: centered 1720px Settings at 3840×2160, with 1600px content.
- `phone-light-added-store.png` and `narrow-dark-enlarged-added-store.png`: delayed successful list refresh after adding a third row. The focused Add control remains visible; the success notice follows the active theme.

The bounded geometry audit covers normal/enlarged text, both modes, minimized restoration and desktop placement. The retained store flow separately tests row growth, delayed refresh, deletion and closing pending requests. See [VISUAL-QA.md](../../VISUAL-QA.md).

Published beta32 still has the original scrolled-header defect, documented in [its screenshots](../live-beta32/README.md). A new release and released-image UI check remain required.
