# Navigation and app launchers

The dock switches between full pages on every screen size. Home and the Orbis wordmark open the workspace. Sections use normal browser URLs and Back/Forward navigation; there are no minimize, maximize or window placement controls for these pages.

## Section transitions

Moving along the dock slides the content in the same direction. The system bar and dock stay in place. Browsers without View Transitions use a short entrance animation. Reduced-motion preferences disable these transitions.

Pages scroll normally. Keyboard focus clears the sticky system bar, fixed dock and minimized-app tray. Resizing preserves the mounted page and its unsaved inputs. Changing sections or reloading follows ordinary page navigation; save form changes before leaving.

## Desktop app launchers

On screens at least 1100px wide and 640px high, selecting an app from Home or Apps opens a small launcher panel. It shows the app's current status, available server addresses and a link to app settings. The panel can remain open while navigating between sections. Escape or Close dismisses it.

Minimize folds the launcher into a compact tray above the dock. The tray expands with a short spring motion as apps are added. Select an app icon to restore its launcher. Each icon has the full app name as its accessible label and hover tooltip, with a separate Close control. Opening a different app keeps the previous launcher in the tray. Reduced-motion preferences remove the minimize, restore and tray animations.

The tray holds launcher names and app identifiers in the current browser tab. It does not embed app sessions or keep minimized app details polling. Reloading clears this list. Minimizing or closing a launcher leaves the Docker app running; an application's separate browser tab is unaffected.

**Open app** opens the selected application address in a separate browser tab. Orbis does not preload or embed the application's interface. The launcher fetches details only for the selected app and refreshes them every 15 seconds while visible; background refreshes stop when the browser tab is hidden.

On phones, tablets and short screens, app cards open their normal details page. App launch actions open the application's address directly. Resizing to a smaller screen closes the active desktop launcher and hides the tray. The minimized list returns if the same tab is resized back to a desktop viewport.

App addresses use the installed port, configured domain or local domain, TLS port and URL suffix. Apps that are stopped or have no web interface do not receive an active launch link. Existing account window placement data is retained for compatibility and is not used for section navigation.

This navigation is in current source. The published `v0.1.0-beta.62` image still has the previous desktop window behavior.
