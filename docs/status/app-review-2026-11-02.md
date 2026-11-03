# Counterpart hands-on review — Nov 2, 2026 (night)

Observed on the installed Mac app (build `202611030005`) and on Davica3 through Device Hub, with the
real Guitar pick project and a real P1S print. Each item says what a person sees and, where traced,
why. Ordered by how much it hurts someone who just wants a thing printed.

## Broken: the app loses what the person asked for

1. **A two-colour request prints in one colour.** The request said black pick, yellow "Vivi", using
   the AMS. Pass 4 built exactly that as `out/vivi_pick_2color.3mf` (letters as a separate part on
   filament 2). Counterpart keeps only `out/touched.stl` (`touchup/runner.ts:204`) and copies it to
   `current/model.stl` (`objects/service.ts:1640`). A single STL has one part, so the Print sheet offers
   one colour row ("Model") while the menu lists all four spools. The pass contract only allows an STL
   (`touchup/invocation.ts`: "Export the final model to out/touched.stl"). The Bambu MCP already has
   `counterpart_make_3mf` for exactly this.
2. **The AI tells a normal person to do slicing.** Because it has no way to return parts and colours,
   the pass writes them into "What changed": "Slice with black on filament 1 and yellow on filament 2;
   fine layers (0.1 mm)…". It also promised "I'll slice it with black on filament 1 and yellow on filament 2"
   — something the app cannot do with an STL.
3. **The fine layers it asked for are ignored.** The reply says 0.1 mm is needed for the letters; the Print
   sheet defaults to Standard, 0.20 mm.
4. **A failed design pass looks successful.** Pass 3 (11:08 PM) has status `failed` and no stored reason.
   Activity shows it with green checks through "Saving the result". David resent the same message a
   minute later; both copies appear in the Request thread with nothing in between explaining the failure.

5a. **The preview you trust is the AI's picture, not the model.** The canvas first showed the pass render with
   yellow "Vivi"; after the Print sheet closed it showed the actual printable model — a plain grey 0.6 mm sliver
   with no lettering. A person approving a print is looking at an image of a different object.

## Misleading numbers and words

5. **Thickness shown as 1 mm for a 0.6 mm pick.** The model is 27 × 30.6 × 0.6 mm; the toolbar badge
   rounds it to "27 × 31 × 1 mm". David's "isn't 1 mm aggressively thick?" came from that badge.
6. **"0 g" filament.** The estimate is 0.49 g; the sheet and Print tab show "0 g".
7. **Stage names describe the wrong job.** A from-scratch guitar pick shows "Getting Blender ready" and
   "Fixing the scan" — there is no scan.
8. **Milestones out of order.** "Halfway there." (11:23) is logged before "First layer's down." (11:24)
   on a three-layer print.
9. **Project start date is wrong-looking.** "Project started Nov 2 at 4:30 AM" for a project David
   started at 10:47 PM: it reused an iPhone draft created at 4:30 AM.
10. **Spool names are developer strings.** "A1 · PLA PLA Basic PLA #000000" — "PLA" three times and a hex
    code instead of "Black".
11. **"Copies: as the printer profile says"** next to a stepper showing 1.
12. **Profile reads "Your printer MCP's preset".** A person doesn't know what an MCP is.
13. **Phone presence flips.** The sidebar footer said "iPhone (13CE) · seen 15 minutes ago" while the phone
    was on screen showing live progress, then "connected" a minute later.

## Phone (Printing screen, after the print finished)

14. **Pause and Stop stay on a finished print.** At 100% "finished" the screen still offers Pause and Stop.
15. **"You'll get a notification when it's done"** is still shown after it is done.
16. **Stale camera next to a finished job.** "Bambu Lab P1S · 2 min ago" still image under a 100% ring.
17. **Speed shows "–"** for the whole print.

## Sheet and controls

18. **Print sheet preview is a grey sliver.** The 0.6 mm pick is shown edge-on with no lettering, while the
    main canvas render shows yellow "Vivi". Neither tells the person what will actually print.
19. **Print sheet Cancel doesn't respond to an accessibility press** (VoiceOver / Switch Control users);
    Escape closes it.
19a. **The sidebar printer row ("Bambu Lab P1S, Ready") doesn't respond to an accessibility press** either.
20. **A stray "Your project" draft** sits in Drafts ("Draft from your iPhone · nothing sent yet").

## Earlier tonight (from the Stop failure)

21. Stop failed with `FULU authenticated stop was rejected (-4)` and the phone stacked two contradictory
    errors (left-over HMS 0500_0500_0001_0007 with Bambu's "update Studio or Handy" text, plus the new one).
    Root cause and fix: see `handoff.md` (MCP route ownership). Pending real-app acceptance.

## Nov 3, early morning (Mac app, Triangle guitar pick)

22. **The Print sheet's "I checked the printer: it isn't already printing this." toggle** appears after an
    unconfirmed attempt and keeps "Print on Bambu Lab P1S" disabled with no visible reason until it is
    ticked. David hit it.
23. **Print failures never reach `events.ndjson`.** Three -3120 cloud failures (01:2x, 01:34, 01:37) left
    the project "Couldn't finish" on the Mac, but no event was written after `print.confirm`, so the phone
    is never told a print failed.
24. **"Getting the print ready" for ~6 minutes after the printer started** (01:46:23 "The printer started
    it." → 01:52:21 "Printing"), then it showed 43% straight away.
25. **The sidebar shows "Bambu Lab P1S, Busy"** after the print finished and the plate was cleared, also
    after a companion restart.
26. **The MCP's "needs a yes before printing" popup** after the app's own Print sheet. David: useless
    friction, Bambu checks the printer itself. Turned off (`BAMBU_REQUIRE_CONFIRMATION=0` in
    `~/bambu-printer-mcp/.env`) and being removed from bambu-printer-mcp itself.
