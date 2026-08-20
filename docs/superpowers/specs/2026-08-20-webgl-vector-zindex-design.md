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

### 1. Per-feature z-index evaluation (CPU side)

- If a style rule has no `z-index` key, it is not evaluated at all — the
  rule's features stay in a single bucket at the default value `0`,
  identical to today's fast path. No performance regression for existing
  styles that don't use `z-index`.
- If a rule declares `z-index`, build one CPU evaluator per rule via
  `buildExpression(expr, NumberType, context)` from `src/ol/expr/cpu.js` —
  the same evaluator Canvas uses (`numberEvaluator`, `render/canvas/style.js`
  around line 294) — so numeric coercion and the `0` default match exactly.
- The raw (un-parsed) `z-index` expression is already retained per rule via
  `sourceRule` (`VectorStyleRenderer.js:260`, `styleShader.sourceRule.style`)
  but not currently extracted; this design extracts and compiles it there.

### 2. Bucketing during buffer generation

- `generateBuffers`/`generateBuffersForType_` (`VectorStyleRenderer.js:431`,
  `:551`) already loop over every feature matching a rule to build vertex
  data. This design adds one evaluator call per feature inside that
  existing loop — not a new pass over the data.
- Features are routed into a `Map<zIndexValue, Feature[]>` per rule. Buffer
  generation then runs once per distinct z-index value found in that rule
  (instead of once for the whole rule), producing one buffer set per
  `(rule, z-index value)` pair.

### 3. Draw units and global sort

- A "draw unit" = one rule's compiled GL programs (fill/stroke/symbol,
  unchanged — still compiled once per rule) + one z-index bucket's buffers.
  A rule with 3 distinct z-index values among its matching features
  produces 3 draw units sharing the same compiled programs.
- `VectorStyleRenderer.render` currently does
  `for (const renderPass of this.renderPasses_)`. This is replaced by:
  flatten all rules' draw units into one array, sort ascending by z-index
  value, and render in that order. Ties are broken by rule declaration
  order (see "Known deviation"). Within one rule's own bucket, feature
  order is unchanged from today (whatever order buffer generation already
  iterates features in).
- No new GL program compilation is introduced; the sort only reorders which
  already-compiled draw units run in which sequence per frame.

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
  (baseline unchanged), single rule with per-feature dynamic z-index
  (`['get', ...]`), multiple rules with distinct z-index values (global
  sort), multiple rules tied at the same explicit z-index (documented
  tie-break by rule order).
- Unit tests on `VectorStyleRenderer` for bucket construction: default
  bucket (no z-index key → no evaluator built, single bucket), constant
  z-index literal, per-feature dynamic expression, and the global sort/
  tie-break ordering of draw units.

## Files touched (expected)

- `src/ol/render/webgl/VectorStyleRenderer.js` — bucket construction, draw
  unit list, global sort, render loop.
- `src/ol/render/webgl/style.js` — extract/compile the `z-index` CPU
  expression instead of (or alongside) the current GLSL-validation-only
  handling in `parseTextProperties`.
- `src/ol/style/flat.js` — JSDoc update documenting the WebGL tie-break
  deviation.
- `changelog/upgrade-notes.md` — Next Release entry.
- `test/rendering/cases/` — new fixtures.
- Unit test file for `VectorStyleRenderer` (existing test file, extended).
