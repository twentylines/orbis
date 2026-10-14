# Orbis server desktop direction

Design read: a personal server workspace for one homelab administrator, with calm mineral surfaces, a composed landscape, and precise operational status. ENERGY 2 / RHYTHM 3 / MOTION 2.

The desktop is a place to launch installed services and notice work that needs attention. The installed applications are the focal point. System readings and activity sit beside them according to their importance. A translucent system bar and dock establish the spatial model; dense application content uses opaque surfaces so wallpaper cannot impair legibility.

## Decisions

- A locally bundled, abstract sandstone landscape anchors the workspace without remote image requests.
- Ink, warm ivory, and sage form the core palette. Copper marks interactive focus. Status colors are reserved for real state.
- System fonts keep platform text familiar and properly licensed. Tabular numerals make changing readings easier to scan.
- The curved horizon repeats in wallpaper and selected surface corners. Corners are varied by function.
- The wallpaper gradient exists to give the desktop depth and quiet space behind applications. No glow or animated background is used.
- The top bar and dock use blur to separate chrome from wallpaper. Work panels are opaque enough for charts, controls, and text.
- Short transitions show navigation and state changes. Continuous animation is avoided, including on status indicators.

## Operating rules

- Show only data returned by authenticated Runtipi APIs. Treat unavailable telemetry as unavailable.
- Keep existing store, lifecycle, backup, authentication, and dynamic form code in place while redesigning its views.
- Use an isolated Docker environment for integration tests. Never bind development to Hades or its Docker socket.
- Preserve the Runtipi license and attribution. Record the upstream commit before rebasing changes.
