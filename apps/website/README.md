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
- there are **no external links**, since the repository and store pages aren't public yet;
- every SVG is either labelled or hidden from assistive tech;
- there is **no pricing text**;
- every text colour pair meets WCAG AA (4.5:1) in both light and dark palettes.

## Rules until launch

- **No pricing** until David decides it (KAN-103). The FAQ says pricing will be shared before launch.
- **No deployment**, and no store, GitHub or analytics links. Add them only once each is public and approved.
- **Licence.** Name no licence until KAN-105 is decided. The FAQ says licence details come before release.

## Claims to re-confirm before launch

Each line on the page should stay true. These depend on decisions or hardware support that can change:
- Scanning needs an iPhone with a LiDAR Scanner (Apple Object Capture), and the app currently needs iOS 18 or later. Importing an existing 3D scan also works.
- The companion runs on a Mac today. Printing preparation depends on macOS sandboxing. A hosted option is undecided (KAN-104), so it isn't mentioned.
- Bambu Lab printers come first, with more printers later.
- Your companion re-checks the printer before starting, and never retries a print on its own.
- With your own companion, scans and photos stay on your devices.
