# WebGL Vector Layer z-index Support — Design

**Issue:** fixes #16331 — "Support zIndex on WebGLVectorLayerRenderer"

## Problem

The `z-index` flat-style property is accepted by the WebGL vector renderer's
style parser but is never wired to anything: `parseTextProperties` (in
`src/ol/render/webgl/style.js`) calls `safeExpressionToGlsl` on it purely to
validate the expression doesn't throw, then discards the result. Draw order
is instead determined solely by the order style rules appear in the rules
array — each rule compiles to one `RenderPass`, and
`VectorStyleRenderer.render` iterates `this.renderPasses_` in that fixed
order.

The Canvas vector renderer, by contrast, evaluates `z-index` per feature
(`numberEvaluator`/`buildExpression` in `src/ol/render/canvas/style.js`),
buckets features by the resulting numeric value in `BuilderGroup`, and draws
buckets in ascending order (`ExecutorGroup`) — a real painter's-algorithm
sort, independent of which style/rule produced each feature.

Goal: bring the WebGL renderer to the same *visual* behavior for the common
case, using an approach appropriate to the WebGL architecture, without
requiring byte-for-byte identical output to Canvas in every case (see
"Relaxed constraint" below).

## Relaxed constraint (2026-08-20)

An earlier iteration of this design required exact parity with Canvas,
including for semi-transparent overlapping features. That constraint has
been relaxed in favor of a much simpler implementation: **GPU depth
testing**. The two approaches considered were:

- **Exact Canvas parity** (rejected as too complex): per-feature CPU
  discovery of z-index values, a new uniform, and one draw call per distinct
  z-index value per rule. Correct in all cases but adds a CPU discovery
  pass, per-draw uniform bookkeeping, cache invalidation, and multiplies
  draw-call count.
- **GPU depth testing** (chosen): write z-index as a per-vertex depth value
  and let the existing depth-test hardware decide per-pixel ordering. Simple
  — reuses infrastructure that already exists in this codebase for
  layer-level depth — but diverges from Canvas for semi-transparent
  overlapping features. See "Difference from Canvas" below for the exact
  behavioral diff.

## Existing precedent for depth-based ordering

This codebase already has a `u_depth` **uniform** used for *layer-level*
z-ordering, which this design extends to *per-feature* granularity:

- `ShaderBuilder.js:27` declares `uniform float u_depth;` in every vector
  shader template.
- `ShaderBuilder.js:612` (symbol/point), `:723` (also symbol-related), and
  `:1009` (polygon/line, via `u_projectionMatrix * vec4(a_position, u_depth, 1.0)`)
  all fold `u_depth` into `gl_Position.z`.
- `TileLayer.js:275` and `VectorTileLayer.js:398,439` set this uniform via
  `this.helper.setUniformFloatValue(Uniforms.DEPTH, depth)` (`Uniforms.DEPTH`
  defined in `TileLayerBase.js:32`) to order whole layers relative to each
  other.
- Depth testing itself is already plumbed through
  `WebGLHelper.prepareDraw(frameState, disableAlphaBlend, enableDepth)`
  (`src/ol/webgl/Helper.js:568`), which enables `gl.DEPTH_TEST`/`gl.LEQUAL`
  when `enableDepth` is truthy (`:598-600`) and clears the depth buffer every
  frame (`:594`). `TileLayerBase.js:466` already calls this with
  `enableDepth: true`. `WebGLVectorLayerRenderer.renderFrame`
  (`src/ol/renderer/webgl/VectorLayer.js:406`) currently calls
  `this.helper.prepareDraw(frameState)` with depth disabled — this is the
  one line that needs to change to activate depth testing for vector
  layers.

Because `u_depth` is currently a per-draw-call *uniform* (constant for an
entire layer), it cannot express per-feature ordering by itself. This
design adds a second, per-vertex **attribute** carrying each feature's
z-index, combined with `u_depth` in the vertex shader.

## Design

### 1. Per-feature z-index attribute (CPU side)

- Add a new custom attribute, `zIndex`, using the exact mechanism already
  used for the `hitColor` attribute (`VectorStyleRenderer.js:227-234`): a
  `{callback, size: 1}` entry in `this.customAttributes_`, evaluated once
  per feature while render instructions are generated
  (`generateRenderInstructions_`, `VectorStyleRenderer.js:505`, and the
  worker-side buffer generation it feeds). No new pass over the data — this
  reuses the per-feature loop that already exists for every other custom
  attribute.
- The callback for a given feature evaluates that feature's matching rule's
  `z-index` expression via `buildExpression(expr, NumberType, context)`
  from `src/ol/expr/cpu.js` (the same evaluator Canvas uses,
  `numberEvaluator` in `render/canvas/style.js` around line 294) — so
  numeric coercion and the `0` default match Canvas exactly at the
  per-feature-value level, even though final visual compositing does not
  (see below). If a rule has no `z-index` key, its features get `0`
  (unchanged from what `u_depth`'s default already implies today).

### 2. Squash into clip-space depth in the vertex shader

- In each subpass's vertex shader (fill/stroke/symbol — the same three
  places that currently reference `u_depth`, `ShaderBuilder.js:612/723/1009`),
  combine the new `a_zIndex` attribute with the existing `u_depth` uniform:
  `float depth = u_depth + a_zIndex / (1.0 + abs(a_zIndex));` and use
  `depth` where `u_depth` is used today.
- The `zIndex / (1.0 + abs(zIndex))` squash maps any real number to
  `(-1, 1)` while preserving order, so no CPU-side discovery of the value
  range is needed — unlike the rejected design, there is no bucketing step
  at all.
- Default case (no `z-index` set anywhere): every feature's `a_zIndex` is
  `0`, squash is `0`, so `depth` reduces to `u_depth` exactly as today —
  no behavior change for existing styles.

### 3. Enable depth testing for the vector layer

- Change `WebGLVectorLayerRenderer.renderFrame`
  (`src/ol/renderer/webgl/VectorLayer.js:406`) from
  `this.helper.prepareDraw(frameState)` to pass `enableDepth: true` (third
  argument), matching the existing `TileLayerBase.js:466` precedent.
- `gl.depthFunc(LEQUAL)` (`Helper.js:600`) means that at equal depth (the
  default, when no rule sets `z-index`), a later draw call still passes the
  depth test and overwrites/blends as before — so enabling depth testing
  unconditionally does not change output for styles that don't use
  `z-index`. Ties between rules at an explicitly equal `z-index` are broken
  by draw order (today's rule-array order), consistent with the tie-break
  already agreed for the rejected design.
- No changes to `VectorStyleRenderer.render()`'s loop structure, no new
  uniforms set per draw call, no new draw calls. The only runtime cost is
  one depth-buffer clear per frame (already paid by other layer types) and
  one extra attribute per vertex.

### Bonus: hit detection respects z-order

`WebGLVectorLayerRenderer.renderWorlds` (`VectorLayer.js:539`) replays the
same render passes into a separate hit-detection render target
(`this.hitRenderTarget_`) when `forHitDetection` is true. Enabling depth
testing for that pass as well means `forEachFeatureAtCoordinate` will
correctly report the topmost feature at a coordinate, which it does not
today (currently whichever rule/feature happens to draw last "wins" at a
given pixel, regardless of intended stacking).

## Difference from Canvas (must be documented)

- **Opaque or near-opaque styles** (the case in #16331 — a highlighted
  stroke): visually identical to Canvas. The nearer feature simply wins
  per-pixel via the depth test.
- **Semi-transparent overlapping features at different z-index**: this is
  the real divergence, and it is a general, well-known limitation of
  combining alpha blending with depth testing (not specific to this
  implementation). Canvas always alpha-composites every overlapping layer
  back-to-front (true "src over dst" blending), so the overlap region shows
  a blended mix of both colors. The depth-test approach shows **only the
  nearer feature's color** in the overlap region — the farther,
  semi-transparent feature is fully hidden there rather than partially
  showing through blended. Styles that are opaque, or that don't rely on
  stacked translucent overlays, are unaffected.
- **Multi-world rendering** (map wrapping, `renderWorlds` looping over
  `startWorld`/`endWorld`): world copies drawn in the same frame share one
  depth buffer. If world copies ever visually overlap on screen (uncommon
  in practice — they normally occupy distinct horizontal bands), depth
  values could leak between them. Worth a quick check during
  implementation; not expected to matter in practice.

This must be documented in:
- `changelog/upgrade-notes.md`, under Next Release.
- The `z-index` JSDoc in `src/ol/style/flat.js` and/or WebGL renderer docs,
  explicitly calling out the semi-transparent-overlap divergence from
  Canvas.

## Testing

- Rendering-test fixtures (`test/rendering/cases/`) covering: no z-index set
  (baseline unchanged, byte-identical to today), single rule with
  per-feature dynamic z-index (`['get', ...]`), multiple rules with distinct
  z-index values (depth test interleaves them correctly regardless of rule
  order), multiple rules tied at the same explicit z-index (documented
  tie-break by rule/draw order), and one fixture with semi-transparent
  overlapping features at different z-index to document/pin the accepted
  Canvas divergence.
- Unit tests on `VectorStyleRenderer` for the `zIndex` custom attribute:
  default case (no z-index key → attribute value `0` for all features),
  constant z-index literal, per-feature dynamic expression evaluating
  correctly per feature.
- A test confirming `WebGLVectorLayerRenderer` now calls
  `prepareDraw(frameState, ..., true)` (depth enabled) where it previously
  passed no third argument.
- A hit-detection test confirming `forEachFeatureAtCoordinate` picks the
  topmost feature by z-index at an overlapping coordinate.

## Files touched (expected)

- `src/ol/render/webgl/VectorStyleRenderer.js` — add the `zIndex` custom
  attribute (mirroring the existing `hitColor` attribute at `:227-234`).
- `src/ol/render/webgl/style.js` — wire the `z-index` expression into a CPU
  evaluator (currently parsed for validation only, in `parseTextProperties`,
  `:1003`), reusing `buildExpression` from `ol/expr/cpu.js`.
- `src/ol/render/webgl/ShaderBuilder.js` — declare the new `a_zIndex`
  attribute and combine it with `u_depth` at each `gl_Position` computation
  (`:612`, `:723`, `:1009`).
- `src/ol/renderer/webgl/VectorLayer.js` — enable depth testing:
  `this.helper.prepareDraw(frameState, ..., true)` at `:406`; also verify
  the hit-detection render path (`renderWorlds`, `:539`) benefits from the
  same depth test.
- `src/ol/style/flat.js` — JSDoc update documenting the semi-transparent
  divergence from Canvas.
- `changelog/upgrade-notes.md` — Next Release entry.
- `test/rendering/cases/` — new fixtures.
- Unit test file for `VectorStyleRenderer` (existing test file, extended).
