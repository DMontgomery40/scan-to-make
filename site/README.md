# Counterpart docs site

The public site at https://counterpart.dtmont.com/: one product on iPhone, iPad, Mac, Android and Linux. A landing page
(`index.html`), the Help guide the apps link to (`help.html`; the iPhone app opens `/help` and `/help#scan`, the Linux app
`/help.html`), beta setup (`beta.html`) and a 404 page. Plain HTML, CSS and one small script, system fonts, no build step.
A Cloudflare Worker serves `public/` (`wrangler.jsonc`); the Sparkle feed `appcast.xml` is served from here too.

```text
site/
├── public/
│   ├── index.html     landing page: three ways to start, what will print, platforms, printers, pairing, privacy,
│   │                  requirements, downloads
│   ├── help.html      the guide for every platform: search (press /), contents that follow your place
│   ├── beta.html      downloads and per-platform beta setup
│   ├── 404.html
│   ├── styles.css     light and dark palettes, glass surfaces; the orange is the app icon's
│   ├── site.js        tabs, zoom, checklist, help search; every page works without it
│   ├── screens/       real app and printer-camera captures (see below)
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

- **Screens.** Every image in `screens/` is a real capture, cropped only (no edits), from `~/scan-to-make-work/` on the
  Mac:
  - `mac-print-sheet.webp`, `mac-what-will-print.webp`, `mac-printer-spools.webp`:
    `site-captures-20261106/03-print-sheet-3d-scan-platform.png` (installed Mac app 202611061750, the 3D scan platform's
    Photography Platform plate, P1S). Cropped above the sheet's last-print warning; the sidebar's device name is cut out.
  - `mac-plates.webp`, `mac-projects.webp`: `site-captures-20261106/01-project-window-3d-scan-platform-as-found.png`
    (same build). Cropped to the Plates strip and to the Ready/Done/Printed part of the list, leaving out the error
    rows and the device name.
  - `bed-screws-early|mid|done.webp`: the P1S camera printing the scan platform's Screws plate on Nov 6
    (`rig-print-20261106/frame-04-printing-0115.jpg`, `frame-printing-0152.jpg`, `frame-printing-0246.jpg`; layers 25,
    45 and 137 of 201 in `watch.log`). The `-640` files are the same frames scaled for the page; the full size opens on
    click.
  Window captures are taken with `screencapture -x -o -l <windowID>` from the Mac's own session, without bringing
  Counterpart forward. Don't pair a Print sheet with a bed photo unless the sheet's colours match what printed. Replace a
  screen with a newer real one when the app changes.
- **`made/*.jpg`**: the app's own renders (`current/renders/1_overview*.png`) of David's printed projects marked "It
  works" (Vivi pick `a2bfa85a`, mic mount `7f157a66`). No generated or stock pictures: every image is the app, the
  printer's camera, or a real part.
- **Written for people who print things.** Plain, confident product copy: no test-status notes, no "real screen" or
  "mockup" captions, no tool names, code, versions, paths or internals tables. Beta status is one line in Downloads.
  Claims still have to be true of what's on main (PRD §0).
- **Start with these** shows the starter catalog's designer projects
  (`packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters/catalog.json`): the scan platform's picture loads from
  the same address the apps use; `made/vernier-caliper.png` is the catalog's `vernier.png`.
- **Icons** are made from `apps/mobile/ios/ScanToMake/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png` (also
  `docs/brand/counterpart-icon-1024.png`). Remake them if the app icon changes.
- **Only describe what's on main.** Features in open pull requests go in when they merge.
- Downloads appear on the landing page and beta setup page. Keep OS requirements, release links and checksums current. TestFlight upload is not external approval; refer readers to TestFlight for current availability.
