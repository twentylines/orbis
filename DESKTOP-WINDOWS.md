# Navigation and app launchers

The dock switches between full pages on every screen size. Home and the Orbis wordmark open the workspace. Sections use normal browser URLs and Back/Forward navigation; there are no minimize, maximize or window placement controls for these pages.

## Section transitions

Moving along the dock slides the content in the same direction. The system bar and dock stay in place. Browsers without View Transitions use a short entrance animation. Reduced-motion preferences disable these transitions.

Pages scroll normally. Keyboard focus clears the sticky system bar and fixed dock. Resizing preserves the mounted page and its unsaved inputs. Changing sections or reloading follows ordinary page navigation; save form changes before leaving.

## Desktop app launchers

On screens at least 1100px wide and 640px high, selecting an app from Home or Apps opens a small launcher panel. It shows the app's current status, available server addresses and a link to app settings. The panel can remain open while navigating between sections. Escape or Close dismisses it.

**Open app** opens the selected application address in a separate browser tab. Orbis does not preload or embed the application's interface. The launcher fetches details only for the selected app and refreshes them every 15 seconds while visible; background refreshes stop when the browser tab is hidden.

On phones, tablets and short screens, app cards open their normal details page. App launch actions open the application's address directly. Resizing to a smaller screen closes a desktop launcher.

App addresses use the installed port, configured domain or local domain, TLS port and URL suffix. Apps that are stopped or have no web interface do not receive an active launch link. Existing account window placement data is retained for compatibility and is not used for section navigation.

This navigation is in current source. The published `v0.1.0-beta.62` image still has the previous desktop window behavior.
