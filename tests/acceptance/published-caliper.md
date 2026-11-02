# Retest: print a published model (the MakerWorld caliper)

This is the acceptance run for PRD §8.11 once KAN-214's PR 7, 7b and 7c and a Mac deploy are live. The check is read-only throughout: it never calls the companion API, never restarts anything and never contacts the printer beyond what the app does. Nothing gets pushed through by hand. If a step fails, the fix goes into the code and the run starts again.

## Steps (on the phone)
1. New → paste `https://makerworld.com/en/models/198362-vernier-caliper-ruler-two-lengths#profileId-232006` with the original words (the 150 mm, or the 220 mm if only that has the depth gauge; the depth gauge; both on one plate; black and yellow; the Counterpart logo in place of the maker's logo) → Send.
2. Answer any Ask the app shows: a file request, a variant choice, or a colour that isn't loaded. Nothing else.
3. When it's Ready, tap Print, check the sheet (P1S, black and yellow, one plate), then Start Print and confirm the printer's check.

## Watch (Mac, read-only)
`~/Library/Application Support/Scan to Make/capture/objects/<id>/object.json` (state, kind, passes, current, print), `…/original/`, and `events.ndjson`.

## Pass criteria
Run:
```sh
python3 -I tests/acceptance/published_check.py \
  --source ~/Downloads/Vernier_Caliper_Ruler_220mm_COLOR-02.3mf ~/Downloads/DEPTH_GAUGE_for_Vernier_Caliper_Ruler_220mm_COLOR-02.3mf \
  --expect-edit INNER --edit-box-mm 40 --colours black,yellow
```
Each check must PASS:
- **Routing:** `kind == "published"`, and no fit or copy design pass.
- **Inputs:** the designer's files are kept byte-for-byte in `original/` (SHA-256).
- **Output:** the current model is a 3MF, with one plate holding OUTER, INNER and DEPTH GAUGE.
- **Geometry:** OUTER and DEPTH GAUGE are exactly as published (object-local vertices and painted triangles). INNER changes only in one region no larger than 40 mm on any axis: the logo.
- **Colours:** the print's `ams_mapping` uses the black and yellow AMS slots.
- **Print:** it was dispatched with a `printId`, the monitor reached `watching` or `ended`, and `print.started` (then milestones and `print.done`) appear in the event log.

The file's own filaments are white (1) and black (2), painted on. "Black and yellow" therefore maps filament 1 to the yellow slot and filament 2 to the black slot.
