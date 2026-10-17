# System status and chrome checks

These captures use the compiled source with labelled development fixtures. They are not released-image or production acceptance.

- Home: 30 groups across six presets, light/dark, 1440px/390px and selected 320px doubled-text cases; minimum small-text contrast 5.19:1 across gradient ends, wallpaper bounds and decorative overlays.
- Monitor: 30 groups, minimum contrast 6.13:1. All presets produce distinct surfaces and 3D materials; dark backgrounds are darker than their corresponding light version.
- Twelve deep-focus samples keep frame scroll at zero. An explicitly enlarged header retains the whole-frame scroll fallback, then restores normal clipping.
- Four phone scroll groups show the upper heading and last Usage values clear of the sticky bar and dock. These are actual-scroll native viewport captures; no scroll reset is applied for these images.
- No browser errors, real preference writes or app/host writes were observed.

The final compiled-source chrome audit passes eight light/dark focused, floating, maximized and phone cases. Six desktop corner probes find zero pale arc pixels. Forward/reverse content slides finish with unique transition names and no browser errors. A matched-wallpaper probe confirms actual blur across 150 sharp-edge samples: mean edge 0.147 against an unfiltered expectation of 0.794. This run uses the compiled fix with no injected CSS.

[Floating glass header](desktop-blush-light-floating-glass.png) · [Light corner](source-r2-blush-light-focused-corner.png) · [Dark corner](source-r2-blush-dark-floating-corner.png)

[Measurements](assertions.json)

[Light Home](desktop-frost-light-text100-home-full-viewport.png) · [Dark Home](desktop-frost-dark-text100-home-full-viewport.png) · [Phone Home](mobile-frost-light-text100-home-full-viewport.png)

[Blush light Monitor](desktop-blush-light-text100-monitor.png) · [Blush dark Monitor](desktop-blush-dark-text100-monitor.png) · [Ocean light Monitor](desktop-ocean-light-text100-monitor.png) · [Ocean dark Monitor](desktop-ocean-dark-text100-monitor.png)

[Enlarged phone status](320-narrow-frost-dark-text200-status-upper-actual-scroll-viewport.png) · [Enlarged phone Usage](320-narrow-frost-dark-text200-status-lower-actual-scroll-viewport.png)

Full-card phone element clips from the broader matrix are diagnostic: they can include fixed chrome overlays. The selected phone detail captures here use ordinary document scrolling instead.
