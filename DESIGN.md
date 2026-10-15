# Orbis desktop direction

Orbis should feel like an operating system for a personal server: a place with a landscape, spatial chrome, applications to launch, and instruments that show what the machine is doing. It should have a recognisable identity beyond generic admin cards. The default visual language is an alpine horizon crossed by one orbital structure, deep mineral green, warm light, and copper instrument marks.

## Composition

- The workspace is open. Installed apps sit on the desktop; live telemetry occupies a dedicated dark instrument panel. Storage and operational notices have their own weight rather than filling a uniform card grid.
- The top system bar identifies Orbis, the current server, the current view, connection state, search, and session control. A floating dock holds the main destinations. Secondary routes open as large windows with a working return control.
- Headings and numbers have strong scale changes. Tight labels and index marks provide detail without competing with the primary data.
- Application logos come from the installed app catalogue. Never invent activity, readings, or a healthy state to decorate a screenshot.

## Material and theme foundations

- Bundle the wallpaper locally. The generated horizon is compressed to a small WebP asset and needs no external image request.
- Use translucent chrome where it gives the desktop depth, and solid enough surfaces behind dense content for clear reading. Keep the wallpaper visible between windows.
- Light and dark are independent of the colour preset. Both modes should change the wallpaper exposure, window surfaces, instruments, text, and system controls; the top bar provides an immediate switch, and appearance settings keep the choice on the account.
- Make system readings feel like physical instruments: recessed live dials, an etched panel, a layered storage marker, and a state-driven operations beacon. These are CSS layers over real values, not a graphics engine.
- CSS tokens drive wallpaper, ink, chrome, surfaces, accent, and headings. Presets may have different character; future full themes should replace all of these together, including app windows and instruments.
- Status color describes actual state. The orange and green lights in the UI must come from connection and application data.

## Motion and performance

- The system bar, dock, windows, panels, and app icons enter with short, staggered motion. Navigation, hover, press, opening search, and editing the workspace each respond visibly.
- Ambient motion is limited to a small scan accent and status beacon within their panels. The scene has no full-screen animation, and reduced-motion disables these effects.
- Live dials update from real samples. Keep animation on transforms and opacity where possible, and do not use a full-screen animated wallpaper or a continuous 3D render loop on the server desktop.
- Honor reduced motion, keyboard focus, narrow screens, and enlarged text. Keep the UI responsive while the data refreshes.

## Operating rules

- Show only data returned by authenticated Orbis/Runtipi APIs. Label missing telemetry accurately; container filesystem and network values are not host-wide readings.
- Preserve upstream app lifecycle, store, backup, authentication, and configuration behavior as the interface changes.
- Use an isolated Docker environment for integration tests. Hades remains untouched until the separate installation phase is authorized.
- Preserve the Runtipi license and attribution, and record upstream state before future merges.
