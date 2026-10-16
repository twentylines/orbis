# App-store settings inspection

These Chrome captures use the compiled Orbis frontend with controlled API responses on the isolated development preview. They are visual and interaction evidence, not a production deployment test.

The current page/window flow matrix covers 1440, 768, 390 and 320px, light/dark, and native/doubled text: 16 groups, 240 states, 64 keyboard-focused table actions and 160 intercepted store operations, including closing pending dialogs. Large screens use windows; smaller viewports use ordinary pages. Selected captures are refreshed after the shared Settings gutter/divider repair. The earlier rendered-surface check covers 64 table/error states and another 64 focused actions. Errors remain inside the dialog; pending actions hold their submitted values, and retry preserves the form.

Long repository addresses have deliberate ellipsis with the complete link text and hover title. Ordinary words remain whole. At 320px with doubled text, long dialog content scrolls inside the panel while the footer stays fixed. The two refreshed `error-scrolled` captures show the end of that content after native wheel scrolling, with at least 44px room below the last line and a stationary reachable footer.

The shared switch keeps its track aligned with the label: 0px centre difference and 10px separation in the final app-store matrix. Separate switch interaction checks and released-image/backend results are recorded in `VISUAL-QA.md` and `DEPLOYMENT.md`.
