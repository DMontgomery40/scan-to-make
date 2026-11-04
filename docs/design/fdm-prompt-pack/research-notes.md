# Research and design rationale

Inspected 3 November 2026. The production prompts are original wording. Sources below informed the manufacturing distinctions and the review process; the package does not install or copy another project's agent instructions.

## Existing work worth knowing about

| Project | What is useful | What needs care for this app |
| --- | --- | --- |
| `KD5RYN/b123d-print` | FDM-specific review, printer/material profiles, fit checks, and measured calibration values for bridges/overhangs. Its design review distinguishes suggestions from failures. | The profile documentation includes generic 45-degree and 10 mm defaults. Those should not become automatic limits for a modern printer or override relevant physical results. [P1, P2] |
| `AaronGoldsmith/mcp-printable` | Blender/OpenSCAD tooling, geometric verification, and conditionally retrieved domain resources. | Its inspected server instruction explicitly favors support-free printing, specifies a 45-degree geometry rule, and treats supports as a last resort. That policy would encourage the exact loss of design ambition this app needs to avoid. [P3] |
| `BoweyLou/llm-to-3dprint` | Makes color strategy, separate inserts, assembly orientation, and slicer-native handoff explicit before CAD. | The instruction file is tightly coupled to its own DesignSpec/routing system. The useful concepts can be expressed much more compactly for an app that already has a workflow. [P4] |
| `mfish82/3D_Print_Optimizer` | Uses an existing 3MF, actual settings, and print outcome history to make targeted changes. | Its README documents incomplete AMS multi-material handling and no in-slicer verification. Its personal material settings should not become general printer capability facts. [P5] |

These projects show that pieces of the workflow already exist. None of the inspected prompt systems supplied the whole combination requested here: ambitious design, modern capability, single-nozzle color economics, sensible assembly, and a deliberately small always-active prompt.

## Why the core prompt uses decisions instead of a catalog of prohibitions

The application already has capable geometry tools and a strong model. The missing responsibility is choosing a manufacturing strategy that preserves the user's desired object. More rigid geometric prohibitions can improve a superficial printability score while degrading the actual product.

The prompt therefore makes the model choose geometry, print orientation, color placement, supports, and joining together. It considers total effort to obtain the finished object, respects user priorities, and allows the easiest useful intervention. An unsupported one-piece design is one possible outcome. So is a curved one-piece print with accessible support, or an attractive multipart print with deliberately designed joints.

It also avoids a forced three-option ceremony. A simple pick or spacer should remain simple. Alternatives are useful when there is an actual manufacturing tradeoff to resolve.

## Overhangs and bridges

The detailed evidence and proposed review bands are in `references/capability-guidance.md`. Three findings matter most:

1. Modern capability extends beyond a universal 45-degree rule. Prusa documents a broader typical range and higher capability for particular cooling systems. [C1]
2. Firsthand Bambu tests include 20 mm clean bridges on a P1S and reported 50 mm bridge strands on P2S/H2S test pieces. [C2, C3]
3. A passing bridge does not establish its dimensional accuracy, the whole printer's maximum, or a guarantee for a different material, width, layer profile, or cooling arrangement.

Bambu's material sheets add official reference values: PETG Basic V3.0 lists approximately 30 mm bridging and approximately 70 degrees overhang; PLA Tough+ V3.0 lists 30 mm and 55 degrees. Their angle convention and feature-test acceptance criteria are unspecified in the retrieved text. The capability reference records those limits alongside the source URLs and distinguishes them from our proposed review bands.

The reference uses review bands to allocate attention. The core does not contain a numeric overhang or bridge veto. The model can retain a demanding shape and solve its local manufacturing difficulty with process, geometry, support, or assembly.

## Multicolor cost is a schedule property

Bambu Studio's own flushing UI stores a filament-pair volume matrix and, for multiple nozzles, separate matrices. This directly supports treating flushing as a property of actual filament transitions and routing rather than a constant cost per color. [M1]

OrcaSlicer's prime-tower documentation describes nozzle-residue cleanup and pressure stabilization, and distinguishes tower implementations. In the Bambu-style process, do not equate the prime tower with all of the filament flushed during a color change. Account for the actual toolpath and the slicer's reported categories. [M4]

For a simple illustrative calculation, a 100 mm object at a uniform 0.20 mm layer height has 500 layers. If two colors occur on every layer, each layer needs at least one transition, so there are at least 500 transitions before considering additional changes between layers. If instead the same two colors occupy two consecutive full cross-section height bands, the model's color pattern calls for one transition between the bands. Startup operations, support materials, and actual slicer ordering are outside this deliberately simplified comparison.

That arithmetic does not say vertical stripes are impossible. It suggests useful ways to keep the finished pattern: another print orientation, a shallow face feature, a separately printed stripe or outer shell, or a decision that the seamless multicolor result is worth its cost.

Separating meshes on a plate does not necessarily change the schedule. A by-layer print can still alternate colors on each layer. Separate single-color jobs may reduce repeated switching; sequential object printing can also matter when the printer/slicer clearance rules actually permit it.

Flushing into infill/support can reduce discarded material. OrcaSlicer's official documentation also warns that mixed-color infill can show through transparent walls and documents conditions under which the feature takes effect. [M2] This is a secondary optimization after sensible color layout, since it does not remove the switching operation and has only the available receiving volume on the relevant layers.

Do not assume support-interface material is compatible structural infill. A firsthand issue in the Bambu Studio tracker reports loss of adhesion after PLA support material entered a PETG object's infill. The report is a specific observation, not a claim that every current version repeats the bug; it is a good reason to inspect the actual slice and material routing. [M3]

## Assembly and glue

Prusa's modeling guidance explicitly treats splitting parts as a way to improve orientation, appearance, and mechanical properties, with gluing and locating pegs among the options. [C1] The package uses that as a normal design tool.

The decision rule is qualitative and job-specific: use a split when its benefit in function, finish, color cost, support access, or repairability is worth the hands-on work. Design the joint and the installation sequence as part of the object. A keyed adhesive insert can be excellent for an accent. A loaded, repeatedly flexing, or serviceable joint may justify mechanical retention. The core does not prescribe a universal adhesive, bond strength, wall thickness, or clearance.

Prusa's separate firsthand assembly guide also describes cyanoacrylate as a useful option for common PLA and PETG prints, while emphasizing application, mating surfaces, appearance, and service conditions. This supports explicitly allowing superglue, including for suitable PETG parts, without inventing a structural allowable for an arbitrary joint. [A1]

## Verification and learning

Use the slice to inspect the actual result, including the current model revision, orientations, material assignments, first unsupported paths, supports, and estimates. Keep total material and any category breakdown consistent. Some tools expose only totals; unavailable breakdowns must remain unknown rather than becoming invented zeroes.

A successful slice is useful evidence, but physical fit and surface quality remain physical outcomes. Store scoped evidence from actual prints so that future designs become less conservative where the user's setup has demonstrated capability. Do not convert a single good test into a global law.

## Source index

### Existing implementations

[P1] b123d-print printer profiles. Inspected file blob `279fe126446dc7a31a29a1ccfa0b2faf49c567f8`:

https://github.com/KD5RYN/b123d-print/blob/main/docs/using/printer-profiles.md

[P2] b123d-print design review rubric. Inspected file blob `b63bed959425d11a81f2937c50d89700e030fa40`:

https://github.com/KD5RYN/b123d-print/blob/main/src/b123d_print/data/design_review.md

[P3] mcp-printable server instructions. Inspected file blob `c676237dffd6c7ef1a5e3cb1c13952360e3329aa`:

https://github.com/AaronGoldsmith/mcp-printable/blob/main/server.py

[P4] llm-to-3dprint parametric CAD skill. Inspected file blob `904cfce1baca3d1b3696652fd8f44a8ba68a6906`:

https://github.com/BoweyLou/llm-to-3dprint/blob/main/skills/parametric-cad-generation/SKILL.md

[P5] 3D Print Optimizer README and instruction file; instruction file blob `3d6541fa6214b82fed102e7b2d124fac86cc55a3`:

https://github.com/mfish82/3D_Print_Optimizer

https://github.com/mfish82/3D_Print_Optimizer/blob/main/SKILL.md

### Capability and modeling

[C1] Prusa modeling guidance:

https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135

[C2] Fab Academy 2026 P2S/H2S characterization:

https://fabacademy.org/2026/labs/nagoya/assignments/week05/

[C3] MIT HTMAA 2025 P1S characterization:

https://fab.cba.mit.edu/classes/863.25/people/RyanHoffman/week3.html

### Color handling

[M1] Bambu Studio flushing UI:

https://github.com/bambulab/BambuStudio/blob/master/resources/web/flush/WipingDialog.html

[M2] OrcaSlicer flush options documentation:

https://github.com/OrcaSlicer/OrcaSlicer/wiki/multimaterial_settings_flush_options

[M3] Bambu Studio issue 10262, firsthand material-routing/adhesion report:

https://github.com/bambulab/BambuStudio/issues/10262

[M4] OrcaSlicer prime-tower documentation, distinguishing cleanup and pressure stabilization:

https://github.com/OrcaSlicer/OrcaSlicer/wiki/multimaterial_settings_prime_tower

### Joining

[A1] Prusa's firsthand glue and assembly guide:

https://blog.prusa3d.com/the-great-guide-to-gluing-and-assembling-3d-prints_44908/

### Prompt application

[S1] Official MCP prompt specification:

https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/prompts.mdx
