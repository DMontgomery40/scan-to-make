# Scan to Make caliper

A printable 0–100 mm vernier caliper with a 0.2 mm vernier. One scale reads both pairs of jaws: the OUTSIDE jaws below and the INSIDE jaws above cross like a real caliper's, so both read 0 when closed and the same number when open. It replaces earlier card calipers whose separate inside and outside lines were hard to read.

- **Front:** "Scan to Make", the main scale (1 mm ticks, numerals every 10 mm, "mm"), the jaw labels, and four through-hole fiducials (FitTag-style scale references; centres in `caliper.json`).
- **Back:** a QR code for the Scan to Make docs (URL is a build parameter, currently a placeholder) and one for mcp-3D-printer-server, each labelled.
- **Two parts on one plate:** the card, and a slider that prints face down. Slide the slider into the slot from the jaw end. A small flexure in the slot takes up the slack.

## Colours

Every printed layer has one colour:

- layers 1–2: the marking colour (the QR codes' light squares are holes);
- then the body colour up to 3.6 mm;
- then the marking colour again for the raised scale and text.

With an AMS that is 2 filament changes. Without one, pause twice and swap the filament by hand (`pause_at_z` in `caliper.json`; pause before the first layer above each height). The single-colour print still works: the scale is raised and the fiducials go right through.

## Why 0.2 mm

PLA on an FDM printer holds about ±0.1–0.2 mm in X/Y, and the printed scale shrinks by about 0.2 % (0.2 mm over 100 mm). The slider has a 0.2 mm V clearance, taken up by the flexure. A 0.1 mm vernier would claim more than the part can deliver. A 0.5 mm reading would throw away what it can. The vernier lines are 2.8 mm apart (5 divisions over 14 mm), so they stay distinct in a phone photo.

## Build

```sh
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -m caliper.build ../../services/companion/src/objects/caliper   # the files the app ships
.venv/bin/python -m unittest discover -s tests -v
```

`legibility.py` (Mac, needs Claude Code signed in) renders openings from a sliced plate and has the touch-up's model read them blind. `qr_decode.swift` decodes QR codes with Apple Vision.

Slicing goes through the user's printer MCP (bambu-printer-mcp `slice_stl`; see its `docs/SLICING.md`). The project file carries no printer settings. The text uses Atkinson Hyperlegible Bold (SIL OFL 1.1, `fonts/OFL.txt`).
