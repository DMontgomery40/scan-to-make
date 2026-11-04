# Practical FDM design prompts

Prepared for David's 3D-printer MCP frontend, 3 November 2026.

## Start here

Use `prompts/01_core.txt` as persistent instructions for the design agent. It is intentionally CAD-independent: the same manufacturing judgment applies whether the agent uses Fusion, Blender, or another geometry tool. Keep the existing modeling workflow.

Load additional guidance only when it can change a decision:

| File | When to use it |
| --- | --- |
| `prompts/01_core.txt` | Every design task. |
| `prompts/02_multicolor.txt` | Multiple colors or support materials share a job. |
| `prompts/03_assembly.txt` | A split, accent insert, or joint is a plausible improvement. |
| `prompts/04_after_slice.txt` | After a candidate has been sliced, before presenting the manufacturing recommendation. |
| `references/capability-guidance.md` | A bridge or overhang is consequential and there is no sufficiently specific measured capability available. |

The research and evaluation notes are for the developer. Do not inject the entire package into every model call. A simple single-color part normally needs only the core prompt and relevant runtime facts. The post-slice prompt is a separate review turn, not repeated inside every CAD tool description.

`integration-notes.md` maps these prompts to the actual tools inspected in David's repositories and identifies the raw slicer-report handoff.

## The design choice these prompts make

The objective is a good finished object with an appropriate total manufacturing burden. Support-free printing, one-piece construction, minimum filament, fewest colors, and zero assembly are possible preferences, not universal objectives.

This matters because a model can obey a long list of printing rules while quietly deleting everything that made the requested object worthwhile. These prompts explicitly preserve the user's intent, allow ambitious geometry, and make the manufacturing response local to the actual difficulty.

The agent should be willing to recommend any of these when justified:

- A one-piece print with a small removable support.
- An unsupported bridge whose underside quality is adequate for its purpose.
- A more favorable orientation with no change to the assembled appearance.
- A single-color structural body plus separately printed colored inserts.
- A keyed glued joint, or a mechanical joint where its loads or serviceability require one.
- The original high-change AMS print when its seamless appearance is worth the cost to the user.

There is no mandatory number of design alternatives, no global waste-ratio veto, no arbitrary weighted score, and no requirement to print a calibration object before every design.

## Runtime context to supply

Provide the facts already available from the app and printer. Keep unknowns explicit, including unknown measurement uncertainty and unavailable slicing metrics.

| Context | Useful contents |
| --- | --- |
| User intent | Function, critical fit, visual requirements, quantity, priorities, any explicit one-piece/no-glue preference. |
| Hardware | Actual printer model, build volume and exclusions, nozzle diameter, independent melt paths, which filament slots feed each path. |
| Process | Effective printer/material/process profiles after inheritance, line widths, layer heights, cooling, support strategy, slicer version. |
| Materials | Actual filament identity and color; compatibility information; relevant environmental and mechanical requirements. |
| Measurements | Value, units, source, known uncertainty, and which mating feature it governs. |
| Capability evidence | Relevant successful and failed feature tests or prior prints, with their material, nozzle, layer profile, cooling, orientation, and acceptance standard. |
| Assembly | Available or acceptable glue, fasteners, inserts, tools, and how much manual work the user will accept. |
| Slice result | Model revision and orientation, toolpath/preview evidence, total predicted time and material, actual transitions if exposed, and whatever non-overlapping material breakdown the slicer genuinely provides. |

Supply only relevant prior-print evidence. A clean 40 mm PLA bridge is evidence for that setup and quality standard; it does not establish a 40 mm universal maximum or transfer unchanged to PETG.

An unknown should trigger a question only if it could materially change the recommendation. For example, a missing pole diameter matters to a fitted clamp. The exact brand of a decorative label's filament may not need to block its first geometry draft.

## Where the prompts belong

Place the core where your frontend actually supplies persistent instructions to its design model. The client can retrieve conditional text through MCP resources or prompts and attach it when relevant. Registering an MCP prompt alone does not guarantee that every tool call will use it. MCP defines discoverable, retrievable prompt templates and leaves the interface pattern to the implementer. Your frontend owns the automatic application of this guidance. [S1]

Apply the manufacturing guidance before detailed CAD, while the architecture and color layout are still cheap to change. Apply the review after slicing, when time, toolpaths, and material estimates can challenge the original plan. Keep the instructions active for revisions as well as initial creation.

Preserve separate assembly and print transforms through the Fusion/Blender handoff. Preserve physical part boundaries and filament assignments. A colored render or a collection of STL meshes is not by itself a verified multicolor slicing project; check the actual imported project and its slice.

## What has been verified

This package contains original prompt wording informed by primary documentation and inspected open-source implementations. The research notes distinguish documented facts, repository behavior, and proposed operating guidance. The prompts have not been benchmarked through David's full application, nor have the example designs been physically printed as part of this work. `evaluation-cases.md` supplies focused cases for that next integration check.

## Source

[S1] Model Context Protocol, server prompts specification, inspected 3 November 2026:

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/prompts.mdx
