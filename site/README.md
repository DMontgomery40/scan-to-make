# Counterpart docs site

The public site at https://counterpart.dtmont.com/: a landing page (`index.html`), the Help guide the iPhone app links to
(`help.html`; the app opens `/help` and `/help#scan`), and a 404 page. Plain HTML, CSS and one small script, no build
step. A Cloudflare Worker serves `public/` (`wrangler.jsonc`).

```text
site/
├── public/
│   ├── index.html     landing page: the step-through, devices, printers, what you need
│   ├── help.html      the guide: search (press /), contents that follow your place, screenshots per section
│   ├── 404.html
│   ├── styles.css     light and dark palettes; the orange is the app icon's
│   ├── site.js        tabs, zoom, checklist, help search; every page works without it
│   ├── screens/       app screens, copied from docs/design/overhaul/screens
│   └── icon-256.png, icon-512.png, favicon.png, apple-touch-icon.png   from the iOS app icon
├── check.mjs          static checks
└── wrangler.jsonc
```

## Preview, check, deploy

```sh
python3 -m http.server --directory site/public 8080   # preview
node site/check.mjs                                   # checks
npx wrangler@4 deploy --config site/wrangler.jsonc    # deploy
```

`check.mjs` checks each page's language, title, description and single `h1`; that every local link, anchor, image and tab
target exists, including the anchors the iPhone app opens; that every image has alt text and a size; that outside links
are on its short public list; that no page still says "Scan to Make"; and that every text colour pair, and white on the
buttons, meets WCAG AA in both palettes.

## Keeping it true

- **Screens** come from the PRD mockups in `docs/design/overhaul/screens` (also in the "Counterpart 2 Overhaul" artifact).
  When the app changes a screen, replace the file here and in that folder. The Mac menu-bar shot is cropped below the
  mockup's title bar.
- **Icons** are made from `apps/mobile/ios/ScanToMake/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png` (also
  `docs/brand/counterpart-icon-1024.png`). Remake them if the app icon changes.
- **Only describe what's on main.** Features in open pull requests (adding printers in Settings, printer connection
  choices on iPhone) go in when they merge.
- The app isn't downloadable yet; the page says so. Add the App Store link and price when they exist.
