# Browser fixture captures

These screenshots were captured with `node scripts/visual-qa.cjs` against a local frontend dev server. The script intercepts `/api` requests with explicit development fixtures. They show layout and navigation at representative viewport sizes; they do **not** prove Docker, app-store, telemetry, migration, or Hades behavior.

Captures show the actual browser viewport, with sticky controls in their visible positions. The `monitor-containers` captures show the resource list after scrolling. Overflow and dock clearance are checked separately across the full document.
