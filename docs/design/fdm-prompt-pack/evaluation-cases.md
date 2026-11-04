# Focused evaluation cases

These are proposed integration checks, not claimed benchmark results. Run them with the same model, tools, and runtime context you intend to ship. Supply actual slicer outputs for metric comparisons. Evaluate whether the agent preserves the brief and makes a sensible manufacturing choice; do not require one predetermined geometry.

## 1. Rode microphone mount on a monitor-arm pole

**Request:** Design a removable mount between my Rode VideoMic GO II and my monitor arm's pole. I will provide the pole measurement and the microphone's mounting interface. Keep the microphone usable and its cable accessible.

**Good behavior:** Identifies the actual mating interfaces and loads; chooses an orientation and clamp geometry that support them; checks installation and fastener access. Allows a separate bracket or sensible local support if useful.

**Regression:** Assumes an unverified thread or pole diameter, treats cosmetic scan noise as critical fit, glues a highly loaded tiny butt joint, or flattens the design to avoid all overhangs.

## 2. Stroller cup holder with a full-height contrasting stripe

**Request:** Make a cup-holder attachment fitted to this scanned handle. Keep the full-height red stripe on the black holder. Simple assembly is fine.

**Good behavior:** Preserves the stripe and the functional holder. Compares the actual AMS schedule against a separate stripe or shell insert, with intentional locating and retention features. Checks loads, clearance, and the installation path.

**Regression:** Silently turns the stripe into horizontal bands, deletes it, calls all vertical stripes impossible, or claims separate bodies printed together by layer eliminate filament changes.

## 3. The same part with a no-assembly preference

**Request:** Keep the same stripe and geometry, but I am happy to spend extra filament to avoid assembly.

**Good behavior:** Honors the changed priority and provides an appropriate multicolor print strategy, with measured slice estimates when available.

**Regression:** Insists on glue or removes the stripe because the prompt treats filament economy as an overriding rule.

## 4. A 60-degree overhang on a modern cooled PLA profile

**Request:** Retain this attractive curved underside. The relevant region reaches 60 degrees from vertical and is not a precision mating surface.

**Good behavior:** Evaluates local geometry and process evidence. Keeps unsupported printing as a plausible candidate, and considers local layer/process changes or modest support as appropriate.

**Regression:** Automatically declares it unprintable because it exceeds 45 degrees, replaces the whole curve with a flat slab, or guarantees success based only on printer age.

## 5. A bridge with different underside requirements

**Request A:** Cover this 30 mm cable channel; slight underside roughness is fine.

**Request B:** Use the same span as a precise sliding contact surface.

**Good behavior:** Treats these as different acceptance problems. Checks actual anchor and toolpath geometry, recognizes material/profile uncertainty, and uses targeted support, reorientation, or a small representative sample when useful.

**Regression:** Gives the same guaranteed result for both requests, treats a two-ended bridge as a one-sided cantilever, or invokes a universal 10 mm prohibition.

## 6. A curved cavity with inaccessible supports

**Request:** Make an enclosed curved duct from the supplied dimensions. Its interior must remain open and usable.

**Good behavior:** Checks whether supports can be inserted and removed. Considers a split with accessible joints, a local internal geometry change, or a verified compatible support process.

**Regression:** Uses trapped ordinary support, assumes soluble support or a different material is available, or presents an exterior render as proof that the interior will print.

## 7. A thin guitar pick

**Request:** Make a simple 0.7 mm pick with the provided outline and a comfortable grip. Single color.

**Good behavior:** Produces an appropriately simple design and checks actual sliced thickness/toolpaths. Preserves intended flexibility.

**Regression:** Demands three alternatives, mandatory calibration prints, multiple parts, thick structural walls, or a lengthy assembly plan for this routine task.

## 8. Finer layers create an AMS tradeoff

**Request:** Improve the underside of this multicolor curved part while preserving its colors.

**Good behavior:** Recognizes that smaller layers can improve overhang geometry while increasing color-change layers. Checks whether local adaptive layers or another small intervention wins after re-slicing.

**Regression:** Globally reduces layer height and declares the result cheaper or better without evaluating the resulting schedule and print time.

## 9. Multiple nozzles with shared filament paths

**Request:** Optimize this three-color part for the supplied two-nozzle configuration. Two colors route through one nozzle and the third through the other.

**Good behavior:** Evaluates the actual routing. Keeps repeated same-nozzle color changes in the cost model while accounting for independent tool changes appropriately.

**Regression:** Equates either AMS slot count or nozzle count with zero flushing waste.

## 10. Missing or stale slice data

**Request:** Choose between these two orientations. One tool result has only total weight and time; the other is from an earlier model revision.

**Good behavior:** Leaves missing purge/support/swap metrics unknown, identifies the stale result, and slices the current candidate when tools permit. Compares equivalent quantity, material, and appearance.

**Regression:** Fabricates a waste breakdown, sums overlapping material categories, treats unavailable values as zero, or quotes the old result as evidence for changed geometry.

## Minimal scoring

Use five independent judgments: intent preserved, manufacturability justified, total burden considered, claims supported by available evidence, and interaction proportional to the task. A useful prompt should perform well on both the ambitious curved/cavity cases and the deliberately simple pick case. An improvement in waste alone does not compensate for deleting a requested visual feature.
