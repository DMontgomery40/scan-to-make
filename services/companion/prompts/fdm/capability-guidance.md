# Bridges and overhangs: useful capability without arbitrary bans

Load this reference only when the feature matters to the manufacturing decision. These are proposed planning bands, not manufacturer guarantees, support-generation settings, or automatic acceptance/rejection rules.

## Scope and terminology

The provisional baseline is an ordinary modern Bambu P-series-class FDM setup, a 0.4 mm nozzle, a suitable PLA profile, normal planar toolpaths, and effective part cooling. Actual printer/material/profile evidence takes priority. Do not transfer the same expectations unchanged to PETG, flexible materials, a different layer height, or a different cooling arrangement.

Angles in the proposed review bands are measured **from vertical**: a vertical wall is 0 degrees; a horizontal underside is 90 degrees. Source values retain their stated or unresolved convention as noted. Slicer controls and test models can use a different convention. Establish their convention before comparing or entering a value. For a simple planar slope, the angle from the build plate is 90 degrees minus the angle from vertical.

An overhang grows sideways from material below. A conventional bridge has extruded paths anchored at both ends. A disconnected island begins with no suitable underlying material or anchorage. They require different decisions.

## What the retrieved evidence establishes

- Prusa's current modeling documentation gives a general 45–60 degree range depending on nozzle/settings, and describes up to 75 degrees for its specifically named Nextruder/360-degree-cooling machines. That is evidence against a universal 45-degree limit. It does not certify 75 degrees on every Bambu printer. [C1]
- A Fab Academy 2026 hands-on comparison of Bambu P2S and H2S used matte-white PLA and reported 50 mm unsupported bridge strands without a visible problem. It also reported some drooping above 60 degrees on the overhang test. This is a useful documented result on particular geometry, not a population benchmark or proof of flat mating-surface accuracy. [C2]
- An MIT HTMAA 2025 P1S characterization reported no noticeable defects on its longest tested bridge, 20 mm, and explicitly left the actual maximum unmeasured. A largest passing sample is not the machine's limit. [C3]
- Bambu's PETG Basic V3.0 data sheet lists approximately 30 mm maximum bridging length and approximately 70 degrees maximum overhang; its PLA Tough+ V3.0 sheet lists 30 mm and 55 degrees. These are material-specific reference values. The retrieved sheets do not define the overhang angle convention or a bridge sag/finish acceptance criterion, so keep the angle values as reported rather than silently normalizing them. Do not assume the mechanical-specimen print conditions also describe these feature tests. [C4, C5]

The material sheets provide useful 30 mm reference points; the firsthand longer prints show why a published or configured maximum should not become a universal geometric prohibition. Filament formulation matters. Avoid a rule that all PLA must outperform all PETG.

## Proposed review bands

These bands decide how much attention to give a feature. They never force a flat design, a split, supports, or a calibration print by themselves.

| Feature on the provisional PLA setup | Working stance |
| --- | --- |
| Progressively supported overhang around 45–60 degrees | Keep an unsupported version as an ordinary candidate. Inspect local curvature, overlap, cooling, and required finish. |
| Overhang around 60–70 degrees | Retain the shape as a candidate; examine local layer height, geometry, cooling, and relevant prior results more closely. Modest support is also an ordinary option. |
| Overhang around 70 degrees or more | Require a stronger process/geometry justification to rely on a clean unsupported result. Consider a representative sample when its result would decide between substantially different plans. |
| Conventional bridge up to about 20 mm | Treat as a plausible ordinary candidate when anchors, toolpaths, and underside requirements are suitable. |
| Bridge roughly 20–50 mm | Keep bridging as a real design option. Pay more attention to actual unsupported path length, anchorage, width, cooling, and sag acceptance. |
| Bridge beyond about 50 mm | Keep it in the design space; seek relevant prior evidence or a small representative test before depending on its quality for an expensive or precise part. |

The 60–70-degree and 20–50-mm bands are deliberate engineering priors for this app. They are not claims that a manufacturer has validated the whole interval. A 12 mm bridge can be unacceptable for a tight sliding surface; a much longer one may be adequate above a noncritical cavity. Avoid turning these bands into a hidden `max_bridge` or `max_overhang` rejection threshold.

## A useful geometric check

For an idealized straight overhang at angle alpha from vertical, layer height h produces a lateral step:

`step = h * tan(alpha)`

Using a nominal extrusion width w, a simple projected overlap estimate is:

`overlap_fraction = max(0, 1 - step / w)`

For a 60-degree overhang and a 0.45 mm line width:

| Layer height | Lateral step | Nominal overlap |
| --- | --- | --- |
| 0.20 mm | 0.346 mm | About 23% |
| 0.12 mm | 0.208 mm | About 54% |

These values follow from geometry, not a printer test. The model omits bead shape, curved toolpaths, cooling, adhesion, and other effects. It explains why layer height can change the outlook; it cannot prove a print will succeed. Use the actual extrusion widths when known.

Ordinary overhang-layer reasoning does not prescribe the best bridge extrusion. OrcaSlicer's documented thick-bridge mode uses a line height equal to nozzle diameter and trades a rougher surface for stronger, more reliable bridges and potentially longer spans. Inspect the actual selected mode instead of assuming bridge height equals ordinary layer height. [C6]

Reducing layer height throughout a multicolor part can also increase the number of color-change layers. Prefer a local intervention when appropriate and re-slice the whole manufacturing plan to see the tradeoff.

## Local interventions to consider

Keep the intervention proportionate to the specific problem. Useful candidates include changing build orientation, adjusting only a hidden underside, replacing the top of a horizontal hole with a suitable printable roof while preserving its necessary clearance, using local adaptive layers, improving a bridge's anchors or extrusion direction, adding a small removable sacrificial feature, placing accessible support, or splitting at a sensible joint.

Preserve roundness where a mating shaft genuinely needs it. Preserve curves where they matter visually. An unremovable support inside a duct is not a valid plan. Do not trade away layer bonding to improve cooling without considering the part's mechanical job.

Treat the slicer's support-generation thresholds as policy settings, not measured capability. For example, OrcaSlicer's `max_bridge_length` decides which anchored spans tree supports leave unsupported. Its configured value does not establish what the machine can physically bridge. [C7]

## What to learn from physical prints

Record the feature and its conditions, not merely a global pass/fail label. Useful evidence includes:

- Largest tested span or angle, plus known failures and untested regions.
- Actual printer, filament identity, nozzle, layer/line profile, cooling, and build orientation.
- Bridge direction, width, anchors, and nearby geometry.
- Whether the criterion was survival, cosmetic quality, measured sag, fit, or load performance.

A small combined coupon at onboarding can complement the printed measuring tool, but it should be optional. Later, print a targeted sample when an important unknown would otherwise put a much larger print at risk. Routine geometry should not repeatedly trigger calibration work.

## Primary sources

[C1] Prusa, Modeling with 3D printing in mind:

https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135

[C2] FabLab Nagoya, Fab Academy 2026 Week 05, firsthand P2S/H2S characterization:

https://fabacademy.org/2026/labs/nagoya/assignments/week05/

[C3] Ryan Hoffman, MIT HTMAA 2025, firsthand P1S characterization:

https://fab.cba.mit.edu/classes/863.25/people/RyanHoffman/week3.html

[C4] Bambu PETG Basic Technical Data Sheet V3.0:

https://store.bblcdn.com/s1/default/cb94589bf7994fdcbfa833badefae9cd/Bambu_PETG_Basic_Technical_Data_Sheet.pdf

[C5] Bambu PLA Tough+ Technical Data Sheet V3.0:

https://store.bblcdn.com/s7/default/80a85371db2e40bda97069d283fed76c/BambuPLA_Tough_TechnicalData_Sheet_%282%29.pdf

[C6] OrcaSlicer bridge settings:

https://github.com/OrcaSlicer/OrcaSlicer/wiki/quality_settings_bridging

[C7] OrcaSlicer advanced support settings:

https://github.com/OrcaSlicer/OrcaSlicer/wiki/support_settings_advanced

All sources inspected 3 November 2026.
