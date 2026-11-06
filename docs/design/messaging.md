# Messaging: how Counterpart explains itself

David, 2026-11-05, about counterpart.dtmont.com: "pretend you never heard of this. then you see 'pair once'… okay?? what?? pair what? what does this place do." And: "you overcorrect and then underexplain and then over explain."

This brief is the fix. Every surface — the site, Help, and the apps' first-run screens — explains the same concepts in the same order, each once, at the moment the reader needs it.

## The one-sentence answer

**Counterpart turns a scan, a description, or a link into the part you need, printed on your 3D printer — designed or cleaned up on your computer, checked by you before it prints.**

The headline form is "Make the part that fits."

## Who it's for

Someone with a 3D printer (or a printer on the way) who needs a specific part: a replacement knob, a mount for the mic they own, a hook that fits their desk edge, a filler for an 8 mm gap. They are not CAD users and don't want to become one. They have a phone and a Mac or Linux PC. They may also find models other people published and want them printed as designed, or changed a little.

They arrive knowing none of our words. Assume they know what a 3D printer is and nothing else.

## The three pillars: what Counterpart stands for

David, 2026-11-06, about the first version of this brief's site: "now there is not a single fucking mention of the fact that it's self hosted and open source?? it looks like every lame app on earth that doesn't actually do anything and is some bs saas shit, this is none of that… don't make it all about that, don't make it all about any one thing, but make it about something."

Explaining clearly is not enough; the page must also stand for what makes Counterpart different. Three pillars, each with **one** prominent moment on the page — balanced, never one theme everywhere:

1. **End to end, and nothing else does it.** Your phone → scan, describe or link → designed or cleaned up → exactly what will print → the part on your printer bed. Every step is in one app. Scanning apps stop at a model; design apps stop at a file; printer apps start at someone else's design. *Its moment:* the chain directly under the hero, once, plus the comparison table that proves it.
2. **Designed for your printer, not generic.** Before designing, Counterpart reads the actual printer — model, nozzle size and count, build volume, loaded filament and colours (every AMS spool), effective profiles — and plans the part with FDM engineering judgment: orientation, overhangs and bridges judged for that setup, supports only where they earn their keep, splits/inserts/joints when they beat one piece, walls where the load is, and colour-change cost counted. After slicing it reviews the real toolpaths, time and grams, and changes the design if the slice disagrees. Sources: `docs/design/fdm-prompt-pack/` (README, research-notes, integration-notes), published in both printer MCPs (PRD §0). *Its moment:* one section, "Designed for your printer", after What will print.
3. **Yours.** Self-hosted: the work happens on your Mac or Linux PC and nothing goes to a Counterpart cloud. No account, no subscription. You bring your own AI (Claude Code, Codex, an API key, a local model) or turn it off. The printer software is open source — bambu-printer-mcp and mcp-3D-printer-server, GPL-2.0, linked on GitHub (verified via the GitHub licence API, 2026-11-06). Counterpart itself is open source under GPL-3.0 (LICENSE added 2026-11-06, David: "gpl 3").

Balance rule: each pillar gets its section and is only *referenced* elsewhere in a clause at most (the hero lede's outcome, "Free — no account, no subscription" at Download). Any pillar that starts appearing in every section is the overcorrection David called out, in either direction.

## The concepts, in order

A newcomer needs four things, in this order. Each is explained once, in full, where its row says, and only referred to briefly anywhere else. Nothing later in the list may appear before the things before it make sense.

| # | Concept | The sentence that carries it | Where it's explained in full |
|---|---|---|---|
| 1 | **You need a part.** Counterpart is for the moment something is missing, broken, or doesn't fit. | "Make the part that fits." (Examples: a hook that fits my desk edge, a filler for this 8 mm gap.) | The hero headline and lede; the first screen of each app. |
| 2 | **Three ways to start:** scan the object with your phone, describe the part in your own words, or paste a link to a published model. | "Scan it. Describe it. Paste a link." | The hero lede (one sentence), then the "Three ways to start" section (one card each). In the apps, the New sheet is the same three. |
| 3 | **You check it, then it prints.** Counterpart designs the part or cleans up your scan, shows you exactly what will print, and prints it on your printer. You can ask for changes in plain words. | "See exactly what will print before it starts." | "How it works" (the steps from request to print) and "What will print". Everything before this is need and input; this is where AI, cleanup and the printer first appear. |
| 4 | **What you need:** a computer, a phone if you want to scan, and a printer. | "Your computer makes it. Your phone goes where the object is. Your printer prints it." | One section ("What you need"), after the reader knows what Counterpart does. Privacy repeats the one fact that matters there (your scans and projects stay on your computer). Nowhere else. |

### Where "it runs on your own computer" lives

It is pillar 3, stated plainly in its own section — and a supporting fact inside concepts 3 and 4. It is never the headline, and never repeated as a refrain:

- In "How it works" it appears because that's where the making happens: "Your computer makes it."
- In "What you need" the mechanics are explained once: which computer (a Mac or a Linux PC), that your phone connects to it, and that connecting is automatic with the same Apple Account or a code you scan once.
- In "Yours" (the former Privacy section) it is the point: "Counterpart is self-hosted: it runs on your Mac or Linux PC, and nothing goes to a Counterpart cloud." That is the one place "self-hosted" appears, explained in the same sentence. Help's Privacy section opens with the same sentence.
- At Download, one clause: "Free — no account, no subscription."

A reader at the top must first know what Counterpart makes; a reader who reaches Download must know it runs on their computer, costs nothing, and whose code they can read.

### Where printers and printer software live

Inside concept 4, once: Counterpart works with Bambu Lab, Prusa, Klipper, OctoPrint and others, through free printer software you install from Settings › Printers. The two programs are named there, and in Help and Credits — the places a person setting up a printer is reading. They are not named in the hero, and "MCP" is never used.

## The words

| We say | We never say | Why |
|---|---|---|
| connect, connection, connected | pair, pairing, paired | "Pair" names a mechanism, not a purpose. A phone connects to a computer so the computer can make the part and run the printer; say that. (Code identifiers keep their names.) |
| your computer (or "your Mac" where only a Mac fits) | companion, host, bridge, server | The thing on their desk. |
| runs on your Mac or Linux PC; "self-hosted" once, explained in the same sentence | self-hosted (unexplained, or repeated) | David wants the fact stated, not hidden and not harped on: "Counterpart is self-hosted: it runs on your Mac or Linux PC, and nothing goes to a Counterpart cloud." Once, in Yours and once in Help's Privacy. |
| open source: Counterpart (GPL-3.0) and its printer software (GPL-2.0) | "built in the open" as a stand-in for a licence | Counterpart is GPL-3.0 since 2026-11-06; the printer software is GPL-2.0. |
| printer software | MCP, MCP server | An internal protocol name. The programs themselves are named where a person installs them. |
| what will print | the sliced file / the slice, before it's explained | "Sliced" is fine after one plain gloss ("prepared for your printer, layer by layer — sliced"). Before that, say "what will print". |
| loaded spools, colours | AMS (first mention) | Name Bambu's AMS only after "the colours loaded in the printer" is understood. |
| scan, describe, paste a link | capture, input, job (for the person's request) | Their verbs. |
| project | job, pass | What the apps show. |

Rules for every surface:

1. **Answer the need before the mechanism.** If a sentence explains how something connects, the reader must already know what it's for.
2. **Explain each concept once, in its place.** Later references are short ("your computer", "what will print"), never a second full explanation. The same fact stated in the hero, the steps, the platforms section, Privacy and the footer is over-explaining.
3. **No concept before its turn.** Connecting a phone is never mentioned before the computer's job is understood. Printer software is never named before printers. Nothing is "just" or "simply" anything.
4. **Concrete over general.** "A hook that fits my desk edge" beats "custom parts". Millimetres beat "accurate".
5. **No dev, prompt or meta text.** Nothing about how the page, the illustrations or the product was made; no disclaimers; no tool names; nothing in the voice of the team ("we did not invent…").
6. **Short.** If a section needs a second paragraph to be understood, the first one is wrong.

## The home page, mapped to the concepts

| Order | Section | Concept | Space |
|---|---|---|---|
| 1 | Hero: headline, lede, Download | 1 and 2 (the need; the three ways in one sentence) | Headline + two sentences |
| 2 | The chain (pillar 1) | 3, whole journey | Five nodes + two sentences, once, under the hero |
| 3 | Three ways to start | 2 | Three cards, two short paragraphs each |
| 4 | How it works | 3 | Six one-line steps, request → printed part |
| 5 | What will print | 3 | Pictures of the exact print, three one-line facts |
| 6 | Designed for your printer (pillar 2) | 3 | One paragraph + three facts. Its only section. |
| 7 | What people make with Counterpart | 1 (proof, after the reader knows how) | Verified real projects only, request quotes |
| 8 | Compare (pillar 1, proven) | — | One table, ✓/✗/partly; sources below, never on the page |
| 9 | What you need (platform tabs + checklist) | 4 | Two sentences + one panel per platform |
| 10 | Printers | 4 | One paragraph; the two programs named here |
| 11 | Connect your phone | 4 | One sentence of why, then the three ways to connect |
| 12 | Yours (pillar 3; id `privacy`) | 4 | Self-hosted sentence + four one-line facts |
| 13 | Quick answers | Leftovers | Five questions, linking to Help |
| 14 | Start with these | Start | The two starter projects |
| 15 | Download | Start | One card per platform, last thing on the page |

**Images are claims.** A project photo may appear only if it is verified against that project (`object.json`, the pass that produced it, and the printer camera's done frame under `prints/<id>/frames`). #359 removed two that weren't. Generated pictures never stand in for a real project.

Help follows the same order (set up → connect a phone → start a project → …) and opens with the one-sentence answer. The setup page (beta) is concept 4 and Start only.

## Comparison table: sources and fairness rules

Checked 2026-11-06 against each product's own pages. Every cell must be re-verified before the table changes; where a competitor is better, the table (and the note under it) says so. ✓/✗ judge the named product itself, not what downstream software does with its exports. "Not listed" means not on the official features/pricing pages consulted — it cannot rule out an unlisted beta.

The page shows five columns and seven rows, marks only (rebuilt 2026-11-06 after David: "make this actually readable … redo it from scratch"). Merged columns: Scanning apps = Polycam + KIRI; AI generators = Meshy + Tripo; CAD = Tinkercad + Fusion + Shapr3D; Slicers & printer apps = Bambu Studio + PrusaSlicer + OctoPrint (MakerWorld and Printables appear only in the note, for their model libraries). A merged cell is ✓ when all or most of its products fully do it, partly when only one does or it's limited, ✗ when none do — derived from the per-product findings below, never re-judged on its own. Rows come in two groups: five steps of the job (scan, design from a description, designed for your printer, shows exactly what will print, prints and watches), then "Yours" (runs on your own computer; open source, no subscription), so the step rows carry the "one or two steps" story and the slicers' open-source ✓ stays honest. Qualifiers are at most three words; the fair "where others are better" details sit in one note under the table.

- **Polycam** — poly.cam/pricing, /tools/3d-lidar-scanner, /ai-capture, /object-capture, App Store id1532482376. LiDAR ✓; remesh/crop + STL, no watertight guarantee; cloud photogrammetry; Basic $150/yr. Better: floor plans/as-builts, CAD/BIM exports, drone capture.
- **KIRI Engine** — kiriengine.app/features, /features/lidar-scan, /features/photo-scan, /pricing, App Store id1577127142. LiDAR ✓ (local + offline for Object Capture); quad retopo/decimation, no manifold guarantee; Pro $79.99/yr. Better: free tier, featureless-object scans, 3DGS + PBR pipeline.
- **Scaniverse** — nianticspatial.com/pricing + /faq/scaniverse, App Store id1541433223. Places/splats for robotics/VPS; no printable repair on current pages. (Researched; grouped under scanning apps on the page only via Polycam/KIRI to keep the table readable.)
- **Apple Object Capture / Reality Composer** — developer.apple.com WWDC23 10191, PhotogrammetrySession docs, App Store id1462358802. What Counterpart's scanning stands on: guided LiDAR capture, on-device USDZ, no printable repair/slicing/printing. Free.
- **Meshy** — meshy.ai, /3d-printing, /features/text-to-3d, /pricing, /integrations/bambu-studio. Text/image ✓; watertight + auto-repair for *generated* models; AMS vertex colours, wall checks, splits; doesn't slice (hands to Bambu Studio); no send/monitor (print-and-ship instead); cloud credits from $20/mo. Better: generation, PBR, rigging/animation.
- **Tripo** — tripo3d.ai, /pricing, /3d-print, /research/triposr. Text/image ✓; "print-ready" generated meshes (its FAQ still says check in your slicer); bed-size segmentation; no in-product slice/send; cloud credits from $20/mo (billed yearly). Better: 2M-poly detail, Smart Mesh quads, DCC bridges.
- **Luma** — lumalabs.ai now sells image/video agents; no live Genie/3D page exists (sitemap checked 2026-11-06), so Luma is **not** a table column. Noting the absence here so nobody re-adds it from memory.
- **Tinkercad / Fusion / Shapr3D** — tinkercad.com + help-center (free, browser, cloud account; STL/OBJ import under 25 MB; manual primitives/Codeblocks; export STL; third-party-app print handoff, no monitoring); help.autodesk.com Fusion (Insert Mesh only, powerful *manual* Repair/Convert Mesh; Autodesk Assistant natural-language commands since Mar 2026, parametric history preserved; additive setups + toolpath simulation for FFF etc.; G-code file to transfer; cloud-centred projects; free limited personal / $680/yr); shapr3d.com + support.shapr3d.com (mesh stays mesh, no auto-repair; AI = renders + chatbot, not text-to-part; sends to PrusaSlicer/Bambu Studio/OrcaSlicer from Export; local-first + Cloud Sync; Free / Solo $199.99/yr / Studio $449.99/yr). Better: precision and parametric editability (Shapr3D Parasolid, Fusion history + CAM/simulation), first-design simplicity (Tinkercad).
- **MakerWorld + Bambu Studio/Handy** — wiki.bambulab.com (Fix Model, View Slicing Information, Remote Control, Handy Quick Start), github.com/bambulab/BambuStudio (AGPL-3.0 slicer; based on PrusaSlicer), blog.bambulab.com MakerLab launch. MakerLab's video "AI Scanner" and PrintMon text generation were discontinued (date from a MakerWorld notice quoted on Bambu's official forum, forum.bambulab.com/t/259960 — one step below the other sources). Handy one-tap printing is Bambu-only; default Auto mode sends files via Bambu's cloud (LAN mode exists). Better: tightest vendor phone flow, AMS auto-assignment, huge model library.
- **Printables + PrusaSlicer** — prusa3d.com/prusaslicer ("No account required… works offline", 200+ tested profiles, "over 2 million free models", free), help.prusa3d.com (Simplify mesh, G-code viewer), PrusaSlicer LICENSE (AGPL-3.0). Sending ✓, monitoring is Prusa Connect (separate). Better: slicer maturity/profiles, library size, fully offline.
- **OctoPrint** — octoprint.org, docs.octoprint.org (Features, GCode Viewer), github.com/OctoPrint/OctoPrint (AGPL). Monitoring is its core job; most consumer printers; self-hosted on your hardware; no scanning/design/slicing of its own.
- **Counterpart column** — this repo (PRD §0 accepted table) and the GitHub licence API: bambu-printer-mcp = GPL-2.0, mcp-3D-printer-server = GPL-2.0, scan-to-make = GPL-3.0 (LICENSE added in #363), all checked 2026-11-06. "Shows exactly what will print" ✓ only for computed prints; a designer's own 3MF profile shows thumbnails by design (PRD §5.9) — the cell says "pictures of the real sliced file", which is the computed-print truth; don't strengthen it.

## The apps' first screens, mapped

- **Welcome (iPhone, Android):** concepts 1–2, then one sentence of concept 4 as a preview of the next step: your computer does the making and printing, so the next step connects this phone to it. Without that sentence, the next screen's camera and code arrive unexplained — the "pair what?" failure in the app.
- **Connect screen (Find your Mac / Find your computer):** its first sentence says what the computer is for. Buttons say **Connect**, never "Pair".
- **Mac first window:** the code and nothing else (David's hard requirement, journey.md §3.4). It carries no explanation because the phone in the person's other hand carries it. Its accessible label says what the code is for.
