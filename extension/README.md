# 🐝 Hivemind Sidekick — Chrome side-panel extension

Pins the Hivemind dashboard into Chrome's **side panel** so your group's compiled
memory — live board, feed and ledger — sits beside whatever you're doing. It
loads the deployed dashboard in `?panel=1` mode, which hides the page chrome and
opens straight on the **Live feed**.

## Before you load it

The side panel points at your **deployed** Hivemind URL, which isn't known until
the app ships. Open `sidepanel.html` and set:

```js
const DASHBOARD_ORIGIN = "https://hivemind-6aebd8e4.base44.app";
```

to your real Base44 app origin (e.g. `https://hivemind-xxxx.base44.app`). Until
you do, the panel shows a "set the URL" notice instead of redirecting.

## Load unpacked (development)

1. Go to `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the 🐝 toolbar icon to open the side panel. (Pin it via the puzzle-piece
   menu if you don't see it.)

Reload the extension from `chrome://extensions` after editing `sidepanel.html`.

## Package for distribution

```bash
./zip.sh          # → hivemind-sidekick.zip (manifest, panel, worker, icons)
```

Upload `hivemind-sidekick.zip` to the Chrome Web Store dashboard.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest — declares the side panel, icons, `sidePanel` permission |
| `sidepanel.html` | Bundled panel page; redirects to the deployed dashboard in panel mode |
| `background.js` | Service worker — opens the panel on toolbar-icon click |
| `icons/` | Honeycomb PNGs (16/48/128) + `generate-icons.mjs` that renders them |

## Regenerate icons

```bash
node icons/generate-icons.mjs
```

Zero-dependency PNG generator (draws honey hexagon cells on the dark theme).
