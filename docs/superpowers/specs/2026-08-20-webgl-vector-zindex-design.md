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

Goal: bring the WebGL renderer to the same observable behavior, as closely
as the two renderers' architectures allow.

## Non-goals

- GPU depth-buffer-based ordering. Rejected: depth-testing discards occluded
  fragments per-pixel rather than alpha-blending them in insertion order, so
  it cannot reproduce Canvas's exact output for semi-transparent overlapping
  features.
- Per-feature draw calls / abandoning batching. True Canvas parity would
  require interleaving individual features from different compiled GL
  programs at the single-feature level when they tie on z-index, which is
  not batchable. See "Known deviation" below.

## Design

**Architecture correction (2026-08-20):** an earlier draft of this section
assumed each style rule gets its own buffer set that could be split by
z-index bucket during generation. That is not how the renderer works.
Reading `WebGLVectorLayerRenderer` (`src/ol/renderer/webgl/VectorLayer.js`)
and `VectorStyleRenderer` (`src/ol/render/webgl/VectorStyleRenderer.js`)
shows:

- There is exactly **one** `MixedGeometryBatch` (`this.batch_`,
  `VectorLayer.js:177`) and **one** `VectorStyleRenderer` (`this.styleRenderer_`,
  `:166`) per layer, holding **all** rules' render passes together.
- `generateBuffers` (`VectorStyleRenderer.js:431`) builds exactly one shared
  `polygonBuffers`/`lineStringBuffers`/`pointBuffers` set for the entire
  layer, once — not once per rule. The actual per-feature iteration happens
  inside a Web Worker (`generateBuffersForType_`, `:551`, dispatched via
  `messageWorker`/`getWebGLWorker`), working on typed-array render
  instructions built once for the whole batch.
- `render()` (`:697`) replays that **same shared buffer** once per rule via
  `this.renderPasses_` (`:698`), each rule's own compiled GL program
  filtering out non-matching features with a GLSL `discard`
  (`builder.setFragmentDiscardExpression`/`setShapeDiscardExpression`,
  `style.js:1060/1062`) — not by having separate buffers per rule.

So there is no per-rule, per-feature CPU loop over feature data to hook
z-index bucketing into. The revised design below extends the existing
"compile a boolean test to GLSL, discard non-matching instances" pattern
instead of introducing new buffers.

### 1. Per-feature z-index evaluation (CPU side, for discovery only)

- If a style rule has no `z-index` key, it is not evaluated at all — the
  rule renders in a single draw call as today. No performance regression
  for existing styles that don't use `z-index`.
- If a rule declares `z-index`, build one CPU evaluator per rule via
  `buildExpression(expr, NumberType, context)` from `src/ol/expr/cpu.js` —
  the same evaluator Canvas uses (`numberEvaluator`, `render/canvas/style.js`
  around line 294) — so numeric coercion and the `0` default match exactly.
- This evaluator is run once per feature in the batch, **only to discover
  the set of distinct z-index values** that occur among the rule's matching
  features — it does not partition any buffers. Discovery reruns whenever
  the batch changes (feature add/remove/change) or the style/variables
  change, mirroring the existing buffer-regeneration triggers in
  `WebGLVectorLayerRenderer.prepareFrameInternal` (`VectorLayer.js:478`).
- The raw (un-parsed) `z-index` expression is already retained per rule via
  `sourceRule` (`VectorStyleRenderer.js:260`, `styleShader.sourceRule.style`)
  but not currently extracted; this design extracts and compiles it there.

### 2. GLSL z-index equality test, driven by a uniform

- Compile the rule's `z-index` expression to GLSL as well (it is already
  parsed for validation only, in `parseTextProperties`, `style.js:1003` —
  this design wires the result instead of discarding it), producing a GLSL
  expression `zIndexExpr`.
- Add a new uniform, `u_targetZIndex` (one per render pass), and extend each
  render pass's discard condition from `!filterExpr` to
  `!filterExpr || zIndexExpr != u_targetZIndex`. When a rule has no
  `z-index`, `zIndexExpr` is the constant `0.0` and `u_targetZIndex` is
  always set to `0` — this reduces to today's discard test unchanged.
- This reuses the existing compiled program and the existing shared
  buffers — no new buffer sets, no new programs. The only new runtime cost
  is calling `helper.setUniformFloatValue('u_targetZIndex', value)`
  (`src/ol/webgl/Helper.js:1079`, already used for other per-draw uniforms
  such as zoom/rotation) before each draw call, and issuing one
  `drawElements`/`drawElementsInstanced` call per distinct z-index value
  instead of one per rule.

### 3. Draw units and global sort

- A "draw unit" = one rule's compiled GL program (fill/stroke/symbol,
  unchanged — still compiled once per rule, now with the extra
  `u_targetZIndex` uniform) + one target z-index value from that rule's
  discovered set. A rule with 3 distinct z-index values among its matching
  features produces 3 draw units, all reusing the same program and the same
  shared buffers.
- `VectorStyleRenderer.render` currently does
  `for (const renderPass of this.renderPasses_)` (`:698`). This is replaced
  by: flatten all rules' draw units into one array, sort ascending by
  z-index value, and render in that order, setting `u_targetZIndex` via
  `renderInternal_`'s `preRenderCallback` hook (`:744`, called right before
  `drawElements`/`drawElementsInstanced`) before each draw unit's call.
  Ties are broken by rule declaration order (see "Known deviation").
- No new GL program compilation is introduced; the sort only reorders which
  already-compiled draw units run, and with which uniform value, in what
  sequence per frame. The default case (no rule sets `z-index`) collapses
  to exactly one draw call per rule with `u_targetZIndex` always `0` —
  identical output and identical draw-call count to today.

### Known deviation from Canvas (must be documented)

Canvas has no "rule" concept at draw time: every feature independently gets
one z-index bucket, and within a bucket, draw order follows feature
iteration order regardless of which style/rule produced it. WebGL compiles
each style rule into its own GL program for performance batching, so true
Canvas parity would require interleaving individual features from different
programs at the single-feature level whenever two rules tie on z-index —
not batchable without one draw call per feature.

**Resolution:** WebGL matches Canvas exactly at the bucket (z-index value)
level — this is the primary thing #16331 asks for. When multiple *different
rules* tie at the same z-index value, WebGL breaks the tie by rule
declaration order (today's existing behavior) rather than feature-render
order. This means:

- Default behavior (no rule sets `z-index`) is **unchanged** — all rules
  default to `0`, tie-break is rule order, which is exactly today's output.
- The existing workaround of ordering rules in the array (as suggested in
  the issue thread) continues to work for the common case.
- Only when two *different* rules both explicitly set the *same* non-default
  z-index value does WebGL's order (rule order) diverge from what Canvas
  would produce (feature-render order) for those tied features. This is a
  narrow, documented deviation, not a silent inconsistency.

This must be documented in:
- `changelog/upgrade-notes.md`, under Next Release.
- The `z-index` JSDoc in `src/ol/style/flat.js` and/or WebGL renderer docs.

## Testing

- Rendering-test fixtures (`test/rendering/cases/`) covering: no z-index set
  (baseline unchanged, same draw-call count as today), single rule with
  per-feature dynamic z-index (`['get', ...]`, producing multiple draw
  units from one rule), multiple rules with distinct z-index values (global
  sort interleaves them), multiple rules tied at the same explicit z-index
  (documented tie-break by rule order).
- Unit tests on `VectorStyleRenderer` for draw-unit construction: default
  case (no z-index key → single draw unit, `u_targetZIndex` always `0`,
  no CPU evaluator built), constant z-index literal (single draw unit at
  that value), per-feature dynamic expression (multiple draw units, one per
  distinct discovered value), and the global sort/tie-break ordering of
  draw units across rules.
- A GLSL-level check (or a rendering test exercising it) that the discard
  condition correctly reduces to `!filterExpr` when `z-index` is absent,
  and to `!filterExpr || zIndexExpr != u_targetZIndex` when present.

## Files touched (expected)

- `src/ol/render/webgl/VectorStyleRenderer.js` — CPU-side discovery of
  distinct z-index values per rule, draw-unit list construction, global
  sort, `render()` loop restructuring, per-draw-unit `u_targetZIndex`
  uniform updates via the existing `preRenderCallback` hook.
- `src/ol/render/webgl/style.js` — wire the `z-index` expression to GLSL
  (currently parsed for validation only, in `parseTextProperties`,
  `:1003`) and fold its equality test into the discard expression alongside
  the existing filter (`:1051-1064`); add a CPU evaluator builder for the
  same expression (via `ol/expr/cpu.js`) for the discovery step.
- `src/ol/style/flat.js` — JSDoc update documenting the WebGL tie-break
  deviation.
- `changelog/upgrade-notes.md` — Next Release entry.
- `test/rendering/cases/` — new fixtures.
- Unit test file for `VectorStyleRenderer` (existing test file, extended).
