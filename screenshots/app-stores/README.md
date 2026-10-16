# App-store settings inspection

These Chrome captures use the compiled Orbis frontend with controlled API responses on the isolated development preview. They are visual and interaction evidence, not a production deployment test.

The complete flow matrix covers 1440, 768, 390 and 320px, light/dark, and native/doubled text: 16 groups, 240 states, 64 keyboard-focused table actions and 112 intercepted store mutations. The final rendered-surface check covers 64 table/error states and another 64 focused actions. Errors remain inside the dialog; pending actions hold their submitted values, and retry preserves the form.

Long repository addresses have deliberate ellipsis with the complete link text and hover title. Ordinary words remain whole. At 320px with doubled text, long dialog content scrolls inside the panel while the footer stays fixed. The two `error-scrolled` captures show the end of that content.

The shared switch keeps its track aligned with the label: 0px centre difference and 10px separation in the final app-store matrix. Separate switch interaction checks and released-image/backend results are recorded in `VISUAL-QA.md` and `DEPLOYMENT.md`.
