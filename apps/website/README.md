# Scan to Make website (preview)

A static, single-page product site. It's plain HTML and CSS with no build step and no dependencies. It isn't deployed anywhere.

```text
apps/website/
├── index.html   # the page
├── styles.css   # the app's palette (light and dark), responsive layout
└── check.mjs    # static checks
```

## Preview

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server --directory apps/website 8080
```

## Checks

```sh
node apps/website/check.mjs
```

The script checks that:
- the page has a language, title, description, a single `h1` and a skip link;
- every in-page anchor resolves and local files exist;
- outside links go only to pages on its public list (today, the two printer servers on GitHub);
- every SVG is either labelled or hidden from assistive tech;
- there is no pricing text;
- the copy mentions LiDAR, iPhone Duo, iPad, iOS 27 and both printer servers, and nothing from the old fit/template product;
- every text colour pair meets WCAG AA (4.5:1) in both light and dark palettes.

## State of things the page depends on

- **Price.** The page names none. The App Store products and price aren't set up yet (KAN-127). Add the price and free-trial terms when they are, and drop the pricing check in `check.mjs` at the same time.
- **Links.** The app's repository is private, and there's no App Store page yet. Add each one to `publicLinks` in `check.mjs` when it goes public.
- **Licence.** The repository has no `LICENSE` file yet. Bambu-printer-mcp's PRD (§10.2, L01) proposes MPL-2.0 for the app. The page says only that the source will be public before release.
- **App Store.** Submission needs public privacy-policy and support URLs. Once this site is deployed, it's the obvious place for them.

## Claims to re-confirm before launch

Each line on the page should stay true:
- Scanning needs a LiDAR Scanner (Apple Object Capture), which is on Pro models of iPhone and iPad. Without LiDAR the app says so instead of faking a scan (David, 2026-10-31).
- The app needs iOS 27 or iPadOS 27 or later.
- iPhone Duo and iPad get their own layouts (KAN-124). iPhone Duo can't scan, but it can open a scan from another device, add close-ups and send prints.
- The app suggests which close-ups to take (KAN-123).
- Clean-up fills holes, smooths lumps, checks size against known measurements, and uses close-ups for fine details (`tools/scan-repair`, `tools/scan-correct`).
- Printing goes through bambu-printer-mcp or mcp-3D-printer-server, chosen in the app (KAN-125). Nothing prints without the user's confirmation: bambu-printer-mcp's own confirmation, plus phone confirmations (KAN-132).
- Both printer servers can work with Blender for model edits. mcp-3D-printer-server lists its backends as OctoPrint, Klipper, Duet, Repetier, Bambu Lab, Prusa and Creality.
- With your own companion, scans and photos go only to it. AI clean-up sends close-ups and rendered views to the model provider.
