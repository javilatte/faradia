---
name: frontend-craft
description: faradia's checklist for interface work. Covers perceived speed (skeletons, optimistic updates, stale-while-revalidate, pre-rendering, BlurHash), keyboard and command UX (command menu, shortcut hints, undo toasts), motion (view transitions, interruptible animations, swipe-to-dismiss sheets, predictive back), touch and layout details (hit slop, safe area insets, one-time code autofill, tabular numbers, balanced headlines, continuous corners, the safe triangle for submenus) and idempotency keys for writes. Use whenever you build, change or review a UI, web or native, and together with /unslop when a screen looks generic or AI-made.
license: MIT
metadata:
  origin: Faradia
---

# Frontend craft

The interface should feel instant, forgiving and precise. Before you call UI work done, go through the sections that apply and adopt each pattern using the project's own stack and components. Do not add a dependency for something the platform already does. If a pattern does not fit the product, skip it. Never force it in to tick a box.

For the look itself (spacing, color, type, copy, visuals), run `/unslop` when it is available. This skill covers behavior and details. unslop covers character.

## Perceived speed

1. **Skeleton loaders.** While content loads, show its shape in the layout it will have: same sizes, same number of rows, a soft shimmer that stops under `prefers-reduced-motion`. Wait about 150 ms before showing any loader so fast responses never flash. Use skeletons for the content area, not a full-page spinner. Keep chrome, navigation and anything already known visible.
2. **Optimistic updates.** For actions that almost always succeed (toggle, rename, reorder, like, move a card), update the UI at once. Send the request in the background. On failure, roll back to the exact previous state and say what failed and what to do. Keep a snapshot per mutation so concurrent ones roll back independently.
3. **Stale-while-revalidate.** Show cached data immediately and refetch in the background. Swap the data in without moving the user's scroll position or focus. Revalidate on focus, on reconnect and after mutations. Mark data as stale only when the age matters to the user ("updated 5 min ago").
4. **Pre-rendering.** Render on the server or at build time anything that does not depend on the user: static pages, the app shell, first-screen content. Prefetch the likely next route on hover, focus or `pointerdown` (or with Speculation Rules `prerender` where supported), never everything at once.
5. **BlurHash placeholders.** For images, store a BlurHash or ThumbHash (or a tiny inline LQIP) with the image's width and height. Paint it as the background until the real image decodes, then crossfade. Always reserve the box (`width`/`height` or `aspect-ratio`) so nothing jumps (CLS = 0).

## Keyboard and command

6. **Command menu.** Offer a ⌘K / Ctrl+K palette that searches every action and destination, with fuzzy matching, recent items first, arrow keys plus Enter, Escape to close, and focus returned where it was. It must work as a proper listbox: `role="combobox"`/`listbox`, `aria-activedescendant`.
7. **Shortcut hints.** Show each action's shortcut where the action lives: in menus, tooltips and the command menu. Show the right glyphs per platform (⌘ ⌥ ⇧ on macOS, Ctrl Alt Shift elsewhere) in `<kbd>`. Never bind single-letter shortcuts while focus is in a text field.
8. **Undo toasts.** Prefer undo to confirmation. Run destructive or bulk actions at once and show a toast "Deleted 3 files · Undo" for about 5–8 s. Pause the timer on hover or focus, and accept ⌘Z / Ctrl+Z. Commit for real only when the toast expires, or make the action reversible on the server. Keep confirmation dialogs for things that cannot be undone.

## Motion

9. **View transitions.** Use the View Transitions API (`document.startViewTransition`, or cross-document `@view-transition`) for navigation and state changes. Name shared elements with `view-transition-name` so a list item grows into its detail. Fall back to an instant change where it is unsupported, and keep transitions short (150–300 ms).
10. **Interruptible animations.** Every animation must be retargetable mid-flight: a new input starts from the current value and velocity, never from the end state, and never waits for the previous animation. Prefer springs or CSS transitions on transforms and opacity over fixed keyframe sequences. Never block input while something animates.
11. **Swipe-to-dismiss sheets.** Bottom sheets and modals on touch follow the finger 1:1. They dismiss past a distance threshold (about 30–40 %) or a fast flick (velocity), and otherwise spring back. Add rubber-banding when the gesture pulls the wrong way. Scrolling inside the sheet takes precedence until its content is at the top. Keep a visible close control and Escape for everyone else.
12. **Predictive back.** Back must always do what people expect: browser back closes the open sheet or menu before it leaves the page, using history state. On Android, support the predictive back gesture (`android:enableOnBackInvokedCallback`, animate the preview with the gesture progress). Restore scroll position and focus when returning.

## Touch, layout and type

13. **Hit slop.** Make every target at least 44×44 pt (iOS) / 48×48 dp (Android), or 24×24 CSS px minimum on the web (WCAG 2.5.8). Grow small visual controls with padding or a transparent `::before` that extends the hit area without moving the layout. Keep 8 px between adjacent targets.
14. **Safe area insets.** With `viewport-fit=cover`, pad edges with `env(safe-area-inset-*)`. Fixed bars add the inset to their own padding, sticky headers use `top: env(safe-area-inset-top)`, and side gutters use `max(16px, env(safe-area-inset-left))`. Use `100dvh`/`svh` instead of `100vh` on mobile.
15. **One-time code autofill.** Code fields use `<input autocomplete="one-time-code" inputmode="numeric" pattern="\d*">` as one field, even when drawn as boxes, so iOS and Android offer the code from SMS or email. Paste fills every box, the code auto-submits when complete, and the SMS ends with `@domain #123456` for WebOTP and origin binding.
16. **Tabular numbers.** Use `font-variant-numeric: tabular-nums` wherever digits change or line up: tables, timers, counters, prices, stats, progress. Right-align number columns.
17. **Balanced headlines.** Give headings and short centered text `text-wrap: balance`, and body paragraphs `text-wrap: pretty` to avoid lone words on the last line.
18. **Continuous corners.** Rounded rectangles use continuous (squircle) curvature, not plain circular arcs, wherever the platform offers it: SwiftUI `.continuous`, `corner-shape: squircle` in CSS behind `@supports`, otherwise a squircle mask or SVG for large hero surfaces. Nested radii follow outer = inner + padding.

## Data and menus

19. **Idempotency keys.** Every non-idempotent write (create, pay, send, submit) sends an `Idempotency-Key` header with a UUID generated once per user intent and reused on retries. The server stores the key with its response and returns the same result for a repeat. Retries and double clicks then never duplicate anything. Disable the submit button while in flight, but rely on the key, not on the button.
20. **Amazon safe triangle.** Nested menus and mega menus keep the submenu open while the pointer moves diagonally toward it. Track the triangle between the cursor and the submenu's near corners, and do not switch items while the pointer is inside it. Add a short close delay (about 300 ms) as a fallback. Keyboard users get Arrow Right / Left to open and close submenus.

## Before you finish

- Run the screen with a slow network (DevTools "Slow 4G") and check the skeletons, optimistic rollbacks and that cached data shows first.
- Try it on a phone-sized viewport with insets, with the keyboard only, and with `prefers-reduced-motion: reduce`.
- Click every submit twice quickly and check that nothing duplicates.
