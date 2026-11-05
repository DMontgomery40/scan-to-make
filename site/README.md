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
│   ├── screens/       real screens (see below) and PRD mockups from docs/design/overhaul/screens
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

- **Screens.** A few UI-only images (pairing, printers, settings) come from `docs/design/overhaul/screens`. The rest are
  real captures, from `~/scan-to-make-work/` on the Mac:
  - `mac-what-will-print.jpg`: `mac-202611050844/print-sheet-what-will-print.png` (installed Mac app, Nov 5).
  - `linux-what-will-print.jpg`: `android-linux-20261105/linux-caliper-preview-enabled.png`, Xvfb margin cropped
    (agents-136 engineering check with a P1S, `linux-receipt.txt`). Never use `linux-add-printer.png`: it shows the
    printer's address and serial.
  - `android-home.jpg`: `android-linux-20261105/android-main745-search-show-all.png` (emulator paired with the Mac,
    `android-main745-receipt.txt`).
  - `iphone-print.jpg`: `phone-pickers-council/r3/device-print-pauses.png` (iPhone, development build, sample data).
  - `iphone-printer.jpg`: `phone-pickers-council/r3/device-printer-connection.png` (same build).
  - `android-what-will-print.jpg`: `android-linux-20261105/android-caliper-print.png`.
  - `made/*.jpg`: the app's own renders (`current/renders/1_overview*.png`) of David's printed projects marked "It works"
    (AirPods Max hanger `5158831c`, Vivi pick `a2bfa85a`, caliper card `1f1c5515`, mic mount `7f157a66`) and the
    Leatherman Wave+ LiDAR scan `ba9346cd`, from `~/Library/Application Support/Scan to Make/capture/objects/` on the Mac.
  Mockups that show sample objects (cable clip, crochet potato, sample mic mount) are not used; only UI-only mockups
  (pairing, printers, settings) remain. Replace a real screen with a newer real one when the app changes; say on the
  page what it is.
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
