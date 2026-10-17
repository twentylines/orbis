# Custom workspace layout checks

These are compiled-source Chrome fixtures, with synthetic apps and browser-only workspace preferences. They do not establish published-image or production acceptance.

All 112 cases pass: 1440/768/390/320px, light/dark, native/doubled text, and seven arrangements. The matrix includes the retained two-app wide arrangement, default layout, equal widths, reordered wide/normal cards, no apps, and eight apps with or without the lower widgets. Ten keyboard End cases check bounded app scrolling. No browser error or attempted real mutation occurred.

The prior source bundle reproduced 577.5px of unused row width and 156.42px of forced launcher height. The corrected custom rows fill their available width; the independent launcher has zero forced blank height. The default grid keeps its existing topology. Paired cards may share the row height.

[Assertions](assertions.json) · [Saved wide layout, light](desktop-light-text100-exact-saved-wide-two.png) · [Dark](desktop-dark-text100-exact-saved-wide-two.png) · [Mixed widths](desktop-light-text100-mixed-seven-five-two.png) · [No apps](desktop-light-text100-wide-empty.png) · [Tablet, enlarged text](tablet-light-text200-half-two.png) · [Phone app scrolling](mobile-light-text100-wide-eight-bounded.png) · [320px keyboard end](narrow-dark-text200-wide-eight-bounded-keyboard-end.png) · [320px without lower cards](narrow-dark-text200-wide-eight-unbounded.png)

Native viewport captures retain their actual reading position. The keyboard-End image shows the scroller after moving to its last control; it is not a reset-to-top composition. Full app names remain accessible where deliberate identifier ellipsis is used. Root and an independent agent manually inspected representative desktop, tablet and phone captures.
