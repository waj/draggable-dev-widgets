# Draggable Dev Widgets

A Chrome extension that makes the debug widgets that sit in the corner of a
dev page draggable:

- The **Elm debugger** widget (the blue Elm logo and message count in the
  bottom-right corner of apps built with `--debug`).
- The **json-render devtools** toggle (the round `{}` button from
  `@json-render/devtools`).

For every widget:

- **Drag** it anywhere. It stays inside the window.
- **Click** it as usual to open the debugger or the devtools panel. Clicks
  that end a drag are ignored. The devtools hotkey (Ctrl/Cmd+Shift+J) still
  works.
- Pages with **several widgets of one kind** (e.g. several Elm apps) get one
  each. They start stacked above each other instead of overlapping, and each
  one is dragged separately.
- Positions are **remembered per origin** (e.g. `http://localhost:8000`), per
  widget in page order.
- **Alt+double-click** a widget to put it back where it started.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Reload any open dev pages.

For `file://` pages, open the extension's **Details** and turn on
**Allow access to file URLs**.

## Limiting where it runs

By default the content script runs on every page but only does something when
it finds one of the widgets. To limit it to your dev servers, change
`matches` in `manifest.json`, for example:

```json
"matches": ["http://localhost/*", "http://127.0.0.1/*"]
```

Then click the reload icon for the extension in `chrome://extensions`.

## How it works

Both widgets are `position: fixed` elements that their library never restyles
after rendering, so the content script moves them with
`transform: translate(...)` and the offset survives re-renders. A
`MutationObserver` watches the page for widgets appearing and disappearing.

- elm/browser renders its widget as a `div` with inline styles
  `position: fixed; bottom: 2em; right: 2em; z-index: 2147483647`. The
  observer follows each debugger as Elm swaps its DOM around (a text node
  while the popout is open, and the same `div` reused as the
  "Click to Resume" overlay while paused), so every widget keeps its own
  position and nothing else gets moved by mistake.
- `@json-render/devtools` mounts a `div[data-jr-devtools-host]` with an open
  shadow root that holds the `button.jr-toggle` and the panel. The script
  reaches into the shadow root for the button, and uses `composedPath()` on
  pointer events so drags and clicks inside the shadow root are seen. The
  panel itself is left alone.
