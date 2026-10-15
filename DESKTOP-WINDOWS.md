# Orbis desktop windows

Orbis uses one current first-party route window. Normal browser URLs, authentication, app actions and account permissions remain authoritative. This keeps the desktop light enough for a server and avoids retaining multiple active editors and collectors.

## Controls

- **Full page** is the default, with normal document scrolling.
- **Floating window** provides a movable title bar, a bottom-right resize control and contained content scrolling.
- **Maximize** fits the available workspace between the system bar and dock. Restore returns to the previous placement.
- **Snap left/right** divides that workspace into equal halves with a 16px gap. It requires room for two 520px windows.
- **Move/resize with keyboard** uses arrow keys in 10px steps, Shift for 1px, Enter to save and Escape to cancel. Moving focus outside the title bar commits the adjustment.
- **Minimize** contracts the current tool toward the dock and opens Home. The current route stays mounted, so an unsaved form survives minimizing and restoring. The current dock item and the Home restore button reopen the exact route and query.
- **Close** returns to Home and discards the current route instance. Choosing another tool follows normal navigation and also replaces the route instance. Unsaved forms are not retained across that navigation or a page reload.

Home and the Orbis brand minimize an open tool. Repeatedly selecting Home while it is already minimized does not add history entries. Minimize and restore are explicit URL states, so Back/Forward can recover their visibility. A minimized URL can be reloaded; it restores saved account placement, not unsaved form content.

Below 900px wide or 540px high, tools use the full-page layout with minimize and close controls. A desktop placement is retained for the next larger viewport. Windows clamp to the available workspace when the display changes. Unsupported browser APIs fall back to immediate visibility changes; reduced-motion preferences skip the dock animation.

## Persistence and resource use

Each account can save placement and bounds separately for Applications, Store, Monitor, Updates, Settings and Tasks. The existing private, atomic desktop-preference storage saves only after a gesture completes, with its usual 300ms debounce. Pointer movement uses animation frames and does not send a request per frame. Keyboard changes are committed once.

Window state accepts only known tool IDs, modes and bounded integer coordinates. It cannot store a URL, application content or form draft. Existing accounts without window state default to full-page tools. Appearance export/import includes the placement map.

Minimized tool content is hidden and inert. Its log EventSources close, including pending reconnect timers. Monitor history and tool polling pause. Home can still request shared host/container statistics, and the system bar continues global app events and task status. Server jobs continue independently of an open tool window.

This model does not embed third-party applications or claim that their pages can be retained safely in frames. Installed app launch links retain the existing server-specific launch behavior.

## Verification

Preference HTTP tests cover authentication, round trips, old accounts, unknown tool IDs, invalid modes, fractional/out-of-range coordinates and rejected extra window data. Geometry tests cover display changes, useful minimum sizes, equal snapping and smaller-display fallback. Browser checks cover visible layout, draft preservation, exact-route/history behavior, pointer/keyboard controls, resizing and log/poll cleanup. Current iteration results are recorded in `VISUAL-QA.md` before publication.
