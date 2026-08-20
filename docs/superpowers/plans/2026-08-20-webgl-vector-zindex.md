# WebGL Vector Layer z-index Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `z-index` flat-style property actually affect draw order in the WebGL vector renderer (fixes #16331), using GPU depth testing.

**Architecture:** Add a per-feature `zIndex` custom attribute (CPU-evaluated, mirroring the existing `hitColor` attribute), wire it into a new `a_zIndex` vertex attribute that combines with the existing (currently layer-level-only) `u_depth` uniform via a monotonic squash function, and enable depth testing on the vector layer's draw calls (main + hit-detection render targets). No new buffers, no new draw calls, no new uniforms.

**Tech Stack:** OpenLayers WebGL vector renderer (`src/ol/render/webgl/`, `src/ol/renderer/webgl/`), `ol/expr/cpu.js` expression evaluator, existing test conventions (chai, `test/browser/spec/`, `test/rendering/cases/`).

**Spec:** `docs/superpowers/specs/2026-08-20-webgl-vector-zindex-design.md`

## Global Constraints

- No new GL programs, no new draw calls, no new uniforms set per draw call (per spec).
- Default behavior (no rule sets `z-index`) must be byte-identical to today's output.
- Depth testing diverges from the Canvas renderer for semi-transparent overlapping features at different z-index (documented, accepted tradeoff — see spec's "Difference from Canvas" section). Do not attempt to fix this; it is out of scope.
- z-index expressions that depend on style `variables` (`['var', ...]`) are evaluated once when vertex buffers are (re)generated (feature add/remove/change), not on every `updateStyleVariables()` call — this mirrors the existing limitation of all other CPU-evaluated custom attributes (e.g. colors depending on `['get', ...]`) and is not being fixed here. Document it; do not build extra invalidation machinery for it.
- z-index expressions using `['id']` or geometry-type operators are not required to work in this implementation (the CPU evaluation context populates only `properties`, `resolution`, and `variables` — not `featureId`/`geometryType`). Document this scope limit; do not implement it.

---

## Task 1: Wire a per-vertex `a_zIndex` attribute into the vertex shaders

**Files:**
- Modify: `src/ol/render/webgl/ShaderBuilder.js:577,612` (symbol/point vertex shader), `:701,723` (stroke vertex shader), `:995,1009` (fill vertex shader)
- Test: `test/browser/spec/ol/render/webgl/shaderbuilder.test.js`

**Interfaces:**
- Produces: every compiled fill/stroke/symbol vertex shader now declares `attribute float a_zIndex;` and combines it with `u_depth` as `u_depth + a_zIndex / (1.0 + abs(a_zIndex))` everywhere `u_depth` was used for `gl_Position`. Task 2 relies on this attribute name (`a_zIndex`) matching the custom-attribute naming convention (`a_${name}` for a `customAttributes_['zIndex']` entry).

- [ ] **Step 1: Write the failing test — update `shaderbuilder.test.js` expectations**

In `test/browser/spec/ol/render/webgl/shaderbuilder.test.js`, apply two mechanical text replacements (every occurrence in the file — there is no ambiguous match, verified: 9 occurrences of the attribute line, 7 of the depth usage):

Replace every occurrence of:
```
attribute vec2 a_hitColor;
```
with:
```
attribute vec2 a_hitColor;
attribute float a_zIndex;
```

Replace every occurrence of:
```
u_depth,
```
with:
```
u_depth + a_zIndex / (1.0 + abs(a_zIndex)),
```

(Use the Edit tool with `replace_all: true` for each of these two replacements in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/shaderbuilder.test.js`
Expected: FAIL — actual shader strings from `ShaderBuilder.js` still lack `a_zIndex`, so `assert.deepEqual` mismatches.

- [ ] **Step 3: Apply the same two replacements to the source file**

In `src/ol/render/webgl/ShaderBuilder.js`, apply the identical two `replace_all` edits:
- `attribute vec2 a_hitColor;` → `attribute vec2 a_hitColor;\nattribute float a_zIndex;` (3 occurrences: lines 577, 701, 995)
- `u_depth,` → `u_depth + a_zIndex / (1.0 + abs(a_zIndex)),` (3 occurrences: lines 612, 723, 1009)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/shaderbuilder.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ol/render/webgl/ShaderBuilder.js test/browser/spec/ol/render/webgl/shaderbuilder.test.js
git commit -m "Add a_zIndex vertex attribute combined with u_depth in WebGL shaders"
```

---

## Task 2: Add the CPU-evaluated `zIndex` custom attribute to `VectorStyleRenderer`

**Files:**
- Modify: `src/ol/render/webgl/VectorStyleRenderer.js:187-260,431,973-1028` (constructor, `generateBuffers`, `convertStyleToShaders`)
- Test: `test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js` (new `describe('z-index custom attribute')` block only in this task; existing broken assertions are fixed in Task 3)

**Interfaces:**
- Consumes: `a_zIndex` attribute name convention from Task 1 (must match `a_${name}` for the `zIndex` entry added to `this.customAttributes_`).
- Produces: `vectorStyleRenderer.customAttributes_['zIndex']` — always present, `{size: 1, callback(feature)}`, returning a number (default `0`). Later tasks (3) rely on this key existing unconditionally in `customAttributes_`.

- [ ] **Step 1: Write the failing tests**

In `test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js`, add a new top-level `describe` block right after the `describe('constructor using shaders', ...)` block (i.e. after the closing `});` that follows line 344, before `describe('methods', ...)`):

```js
describe('z-index custom attribute', () => {
  it('defaults to 0 when no rule declares z-index', () => {
    vectorStyleRenderer = new VectorStyleRenderer(
      SAMPLE_STYLE_RULES,
      {},
      helper,
    );
    const feature = new Feature({
      id: 1,
      size: 1000,
      color: 'red',
      geometry: new Point([0, 0]),
    });
    const value =
      vectorStyleRenderer.customAttributes_['zIndex'].callback(feature);
    assert.strictEqual(value, 0);
  });

  it('evaluates a constant z-index for the matching rule', () => {
    const rules = [
      {
        style: {'fill-color': 'red', 'z-index': 5},
        filter: ['==', ['get', 'group'], 'a'],
      },
      {
        style: {'fill-color': 'blue', 'z-index': 9},
        filter: ['==', ['get', 'group'], 'b'],
      },
    ];
    vectorStyleRenderer = new VectorStyleRenderer(rules, {}, helper);
    const callback = vectorStyleRenderer.customAttributes_['zIndex'].callback;
    const featureA = new Feature({group: 'a', geometry: new Point([0, 0])});
    const featureB = new Feature({group: 'b', geometry: new Point([0, 0])});
    assert.strictEqual(callback(featureA), 5);
    assert.strictEqual(callback(featureB), 9);
  });

  it('evaluates a per-feature z-index expression', () => {
    const rules = [{style: {'fill-color': 'red', 'z-index': ['get', 'rank']}}];
    vectorStyleRenderer = new VectorStyleRenderer(rules, {}, helper);
    const feature = new Feature({rank: 42, geometry: new Point([0, 0])});
    const value =
      vectorStyleRenderer.customAttributes_['zIndex'].callback(feature);
    assert.strictEqual(value, 42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js --grep "z-index custom attribute"`
Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'callback')` (no `zIndex` key exists in `customAttributes_` yet).

- [ ] **Step 3: Thread `effectiveFilter` and `zIndexExpr` through `convertStyleToShaders`**

In `src/ol/render/webgl/VectorStyleRenderer.js`, in `convertStyleToShaders` (around line 1009):

```js
      // parse each style and convert to shader
      const styleShaders = ruleStyles.map((style) => ({
        ...parseLiteralStyle(style, variables, currentFilter),
        sourceRule: rule,
        effectiveFilter: currentFilter,
        zIndexExpr: style['z-index'],
      }));
```

(This replaces the existing `{...parseLiteralStyle(style, variables, currentFilter), sourceRule: rule}` object literal — added fields: `effectiveFilter`, `zIndexExpr`.)

And a few lines below, in the "array of flat styles" branch (around line 1024):

```js
  // array of flat styles: simply convert to shaders
  return /** @type {Array<FlatStyle>} */ (asArray).map((style) => ({
    ...parseLiteralStyle(style, variables, undefined),
    sourceRule: {style},
    effectiveFilter: undefined,
    zIndexExpr: style['z-index'],
  }));
```

- [ ] **Step 4: Add imports**

At the top of `src/ol/render/webgl/VectorStyleRenderer.js`, add:

```js
import {buildExpression, newEvaluationContext} from '../../expr/cpu.js';
import {
  BooleanType,
  NumberType,
  newParsingContext,
} from '../../expr/expression.js';
```

- [ ] **Step 5: Fix the `isUsed` check so the attribute is always bound**

In the constructor, in the `customAttributesDesc` mapping (around line 264-273), change:

```js
      const customAttributesDesc = Object.entries(this.customAttributes_).map(
        ([name, value]) => {
          const isUsed = name in styleShader.attributes || name === 'hitColor';
```

to:

```js
      const customAttributesDesc = Object.entries(this.customAttributes_).map(
        ([name, value]) => {
          const isUsed =
            name in styleShader.attributes ||
            name === 'hitColor' ||
            name === 'zIndex';
```

- [ ] **Step 6: Register the `zIndex` custom attribute in the constructor**

Immediately after the existing hit-detection block (right after the closing `}` at line 234, and before the `// add attributes & uniforms coming from all shaders` comment at line 236), insert:

```js
    // add the z-index custom attribute unconditionally: every feature gets
    // a numeric z-index (default 0) written into the vertex buffer and
    // combined with u_depth in the vertex shader, regardless of whether any
    // rule declares 'z-index' (see
    // docs/superpowers/specs/2026-08-20-webgl-vector-zindex-design.md)
    const zIndexParsingContext = newParsingContext(variables);
    const zIndexEvaluators = this.styleShaders.map((styleShader) => ({
      filterEvaluator: styleShader.effectiveFilter
        ? buildExpression(
            styleShader.effectiveFilter,
            BooleanType,
            zIndexParsingContext,
          )
        : null,
      zIndexEvaluator:
        styleShader.zIndexExpr !== undefined
          ? buildExpression(
              styleShader.zIndexExpr,
              NumberType,
              zIndexParsingContext,
            )
          : null,
    }));
    const zIndexEvaluationContext = newEvaluationContext();
    zIndexEvaluationContext.variables = variables;
    this.customAttributes_['zIndex'] = {
      size: 1,
      callback: (feature) => {
        zIndexEvaluationContext.properties =
          feature.getPropertiesInternal() ?? {};
        zIndexEvaluationContext.resolution = this.currentResolution_ ?? 0;
        for (const entry of zIndexEvaluators) {
          if (
            !entry.filterEvaluator ||
            entry.filterEvaluator(zIndexEvaluationContext)
          ) {
            return entry.zIndexEvaluator
              ? entry.zIndexEvaluator(zIndexEvaluationContext)
              : 0;
          }
        }
        return 0;
      },
    };
```

- [ ] **Step 7: Track the current resolution for the callback above**

In the constructor, near the other private field initializations (e.g. right after `this.uniforms_ = {};` at line 224), add:

```js
    /**
     * @private
     */
    this.currentResolution_ = 0;
```

In `generateBuffers` (line 431), as the first statement in the method body (before `const invertVerticesTransform = ...`), add:

```js
    this.currentResolution_ = resolution;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js --grep "z-index custom attribute"`
Expected: PASS (3 tests)

- [ ] **Step 9: Remove the now-redundant GLSL-validation-only z-index handling**

The CPU evaluator added above (Step 6) is the real implementation; the pre-existing GLSL validation of `z-index` is now dead weight and, if left in place, could raise a confusing duplicate/inconsistent error for a malformed expression from a second, unused code path.

In `src/ol/render/webgl/style.js`, in `parseTextProperties` (around line 1003), remove:

```js
  if ('z-index' in style) {
    safeExpressionToGlsl(context, style['z-index'], NumberType);
  }
```

Run: `grep -n "NumberType" src/ol/render/webgl/style.js | head -5` to confirm `NumberType` is still used elsewhere in the file (it is, for other numeric properties) — so no import needs removing.

- [ ] **Step 10: Run the full style.js and VectorStyleRenderer test files to confirm no regression**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/style.test.js test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js --grep "z-index custom attribute"`
Expected: PASS (removing the dead validation block does not change any existing style.js test, since no test asserted on `z-index`'s GLSL output specifically — verify with `grep -n "z-index" test/browser/spec/ol/render/webgl/style.test.js` first; if a test does assert on it, update that test to remove the now-obsolete assertion rather than deleting the whole test).

- [ ] **Step 11: Commit**

```bash
git add src/ol/render/webgl/VectorStyleRenderer.js src/ol/render/webgl/style.js test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js
git commit -m "Add CPU-evaluated zIndex custom attribute to VectorStyleRenderer"
```

---

## Task 3: Fix existing tests broken by the new unconditional `zIndex` attribute

Adding an always-present custom attribute shifts every existing attribute-layout and buffer-content assertion in this test file. This task makes the full existing suite green again — no new behavior, purely updating expectations to match the (now correct) new layout.

**Files:**
- Modify: `test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js`

**Interfaces:**
- Consumes: `customAttributes_['zIndex']` (Task 2) is inserted into `Object.entries(this.customAttributes_)` right after the conditional `hitColor` entry and before any style-derived `prop_*` entries — so `a_zIndex` always appears immediately after `a_hitColor` (if hit detection is enabled) or immediately after the fixed position/localPosition attributes (if not).

- [ ] **Step 1: Run the full file to see all failures**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js`
Expected: FAIL — multiple `assert.hasAllKeys` and `assert.deepEqual` mismatches, one per block below.

- [ ] **Step 2: Fix the three `assertCustomAttributes` calls**

In the `describe('constructor using style rules', ...)` block (around line 156):
```js
      assertCustomAttributes(vectorStyleRenderer.customAttributes_, {
        zIndex: {size: 1},
        prop_color: {size: 2},
        prop_size: {size: 1},
        prop_id: {size: 1},
      });
```

In the `describe('constructor using style rules & hit detection enabled', ...)` block (around line 229):
```js
      assertCustomAttributes(vectorStyleRenderer.customAttributes_, {
        hitColor: {size: 2},
        zIndex: {size: 1},
        prop_color: {size: 2},
        prop_size: {size: 1},
        prop_id: {size: 1},
      });
```

In the `describe('constructor using shaders', ...)` block (around line 302):
```js
      assertCustomAttributes(vectorStyleRenderer.customAttributes_, {
        zIndex: {size: 1},
        prop_attr1: {},
        prop_attr2: {size: 3},
      });
```

- [ ] **Step 3: Fix the attribute-layout assertions in `describe('constructor using style rules', ...)`**

Around line 173, replace the block from `assert.deepEqual(firstPass.fillRenderPass.attributesDesc, [` through its matching `]);`, and similarly for the other four arrays in this `it`, with:

```js
      assert.deepEqual(firstPass.fillRenderPass.attributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_size', size: 1, type: FLOAT},
        {name: 'a_prop_color', size: 2, type: FLOAT},
        {name: null, size: 1, type: FLOAT}, // this is padding for the `id` attribute
      ]);
      assert.instanceOf(firstPass.strokeRenderPass.program, WebGLProgram);
      assert.deepEqual(firstPass.strokeRenderPass.attributesDesc, [
        {name: 'a_localPosition', size: 2, type: 5126},
      ]);
      assert.deepEqual(firstPass.strokeRenderPass.instancedAttributesDesc, [
        {name: 'a_segmentStart', size: 2, type: FLOAT},
        {name: 'a_measureStart', size: 1, type: FLOAT},
        {name: 'a_segmentEnd', size: 2, type: FLOAT},
        {name: 'a_measureEnd', size: 1, type: FLOAT},
        {name: 'a_joinAngles', size: 2, type: FLOAT},
        {name: 'a_distanceLow', size: 1, type: FLOAT},
        {name: 'a_distanceHigh', size: 1, type: FLOAT},
        {name: 'a_angleTangentSum', size: 1, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_size', size: 1, type: FLOAT},
        {name: 'a_prop_color', size: 2, type: FLOAT},
        {name: null, size: 1, type: FLOAT},
      ]);
      assert.instanceOf(firstPass.symbolRenderPass.program, WebGLProgram);
      assert.deepEqual(firstPass.symbolRenderPass.attributesDesc, [
        {name: 'a_localPosition', size: 2, type: FLOAT},
      ]);
      assert.deepEqual(firstPass.symbolRenderPass.instancedAttributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_size', size: 1, type: FLOAT},
        {name: 'a_prop_color', size: 2, type: FLOAT},
        {name: null, size: 1, type: FLOAT},
      ]);

      const secondPass = vectorStyleRenderer.renderPasses_[1];
      assert.instanceOf(secondPass.fillRenderPass.program, WebGLProgram);
      assert.deepEqual(secondPass.fillRenderPass.attributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: null, size: 1, type: FLOAT},
        {name: null, size: 2, type: FLOAT},
        {name: 'a_prop_id', size: 1, type: FLOAT},
      ]);
```

(Leave the surrounding `assert.instanceOf`/`assert.strictEqual` lines and the `it(...)` wrapper as they are — only the five `assert.deepEqual(...)` array contents above change, each gaining one `{name: 'a_zIndex', size: 1, type: FLOAT}` entry at the position shown.)

- [ ] **Step 4: Fix the attribute-layout assertions in `describe('constructor using style rules & hit detection enabled', ...)`**

Same five arrays, this time with `a_hitColor` present, so `a_zIndex` goes right after it:

```js
      assert.deepEqual(firstPass.fillRenderPass.attributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_hitColor', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_size', size: 1, type: FLOAT},
        {name: 'a_prop_color', size: 2, type: FLOAT},
        {name: null, size: 1, type: FLOAT}, // this is padding for the `id` attribute
      ]);
      assert.instanceOf(firstPass.strokeRenderPass.program, WebGLProgram);
      assert.deepEqual(firstPass.strokeRenderPass.attributesDesc, [
        {name: 'a_localPosition', size: 2, type: FLOAT},
      ]);
      assert.deepEqual(firstPass.strokeRenderPass.instancedAttributesDesc, [
        {name: 'a_segmentStart', size: 2, type: FLOAT},
        {name: 'a_measureStart', size: 1, type: FLOAT},
        {name: 'a_segmentEnd', size: 2, type: FLOAT},
        {name: 'a_measureEnd', size: 1, type: FLOAT},
        {name: 'a_joinAngles', size: 2, type: FLOAT},
        {name: 'a_distanceLow', size: 1, type: FLOAT},
        {name: 'a_distanceHigh', size: 1, type: FLOAT},
        {name: 'a_angleTangentSum', size: 1, type: FLOAT},
        {name: 'a_hitColor', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_size', size: 1, type: FLOAT},
        {name: 'a_prop_color', size: 2, type: FLOAT},
        {name: null, size: 1, type: FLOAT},
      ]);
      assert.instanceOf(firstPass.symbolRenderPass.program, WebGLProgram);
      assert.deepEqual(firstPass.symbolRenderPass.attributesDesc, [
        {name: 'a_localPosition', size: 2, type: FLOAT},
      ]);
      assert.deepEqual(firstPass.symbolRenderPass.instancedAttributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_hitColor', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_size', size: 1, type: FLOAT},
        {name: 'a_prop_color', size: 2, type: FLOAT},
        {name: null, size: 1, type: FLOAT},
      ]);

      const secondPass = vectorStyleRenderer.renderPasses_[1];
      assert.instanceOf(secondPass.fillRenderPass.program, WebGLProgram);
      assert.deepEqual(secondPass.fillRenderPass.attributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_hitColor', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: null, size: 1, type: FLOAT},
        {name: null, size: 2, type: FLOAT},
        {name: 'a_prop_id', size: 1, type: FLOAT},
      ]);
```

- [ ] **Step 5: Fix the attribute-layout assertions in `describe('constructor using shaders', ...)`**

```js
      assert.deepEqual(firstPass.fillRenderPass.attributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_attr1', size: 1, type: FLOAT},
        {name: 'a_prop_attr2', size: 3, type: FLOAT},
      ]);
      assert.instanceOf(firstPass.strokeRenderPass.program, WebGLProgram);
      assert.deepEqual(firstPass.strokeRenderPass.attributesDesc, [
        {name: 'a_localPosition', size: 2, type: FLOAT},
      ]);
      assert.deepEqual(firstPass.strokeRenderPass.instancedAttributesDesc, [
        {name: 'a_segmentStart', size: 2, type: FLOAT},
        {name: 'a_measureStart', size: 1, type: FLOAT},
        {name: 'a_segmentEnd', size: 2, type: FLOAT},
        {name: 'a_measureEnd', size: 1, type: FLOAT},
        {name: 'a_joinAngles', size: 2, type: FLOAT},
        {name: 'a_distanceLow', size: 1, type: FLOAT},
        {name: 'a_distanceHigh', size: 1, type: FLOAT},
        {name: 'a_angleTangentSum', size: 1, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_attr1', size: 1, type: FLOAT},
        {name: 'a_prop_attr2', size: 3, type: FLOAT},
      ]);
      assert.instanceOf(firstPass.symbolRenderPass.program, WebGLProgram);
      assert.deepEqual(firstPass.symbolRenderPass.attributesDesc, [
        {name: 'a_localPosition', size: 2, type: FLOAT},
      ]);
      assert.deepEqual(firstPass.symbolRenderPass.instancedAttributesDesc, [
        {name: 'a_position', size: 2, type: FLOAT},
        {name: 'a_zIndex', size: 1, type: FLOAT},
        {name: 'a_prop_attr1', size: 1, type: FLOAT},
        {name: 'a_prop_attr2', size: 3, type: FLOAT},
      ]);
```

- [ ] **Step 6: Fix the buffer-content assertions in `describe('methods') > describe('generateBuffers') > it('creates buffers for a geometry batch')`**

`SAMPLE_STYLE_RULES` declares no `z-index`, so every injected value is `0`, at the position immediately after each buffer's position/segment attributes (matching the `attributesDesc` order fixed in Step 3, since this test's renderer has no hit detection).

Replace:
```js
        assertArrayLikeEqual(
          buffers.polygonBuffers[1].getArray().slice(0, 6),
          [-45, -47.5, 3000, 128, 255, 3],
        );
```
with:
```js
        assertArrayLikeEqual(
          buffers.polygonBuffers[1].getArray().slice(0, 7),
          [-45, -47.5, 0, 3000, 128, 255, 3],
        );
```

Replace:
```js
        assertArrayLikeEqual(
          buffers.lineStringBuffers[2].getArray().slice(0, 15),
          [
            -45, -47.5, 0, -40, -47.5, 0, 1.5707963705062866, 4.71238899230957,
            0, 0, 0, 3000, 128, 255, 3,
          ],
        );
```
with:
```js
        assertArrayLikeEqual(
          buffers.lineStringBuffers[2].getArray().slice(0, 16),
          [
            -45, -47.5, 0, -40, -47.5, 0, 1.5707963705062866, 4.71238899230957,
            0, 0, 0, 0, 3000, 128, 255, 3,
          ],
        );
```

Replace:
```js
        assertArrayLikeEqual(
          buffers.pointBuffers[2].getArray().slice(0, 6),
          [-45, -45, 1000, 65280, 255, 1],
        );
```
with:
```js
        assertArrayLikeEqual(
          buffers.pointBuffers[2].getArray().slice(0, 7),
          [-45, -45, 0, 1000, 65280, 255, 1],
        );
```

(The `buffers.lineStringBuffers[1]` and `buffers.pointBuffers[1]` assertions — the non-instanced `a_localPosition`-only buffers — are untouched: `zIndex` is a custom attribute that only appears in the per-vertex fill buffer and the per-instance stroke/symbol buffers, never in these plain local-position buffers.)

- [ ] **Step 7: Run the full file to verify everything passes**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js`
Expected: PASS (all tests, including the ones from Task 2)

- [ ] **Step 8: Commit**

```bash
git add test/browser/spec/ol/render/webgl/VectorStyleRenderer.test.js
git commit -m "Update VectorStyleRenderer tests for the new zIndex attribute layout"
```

---

## Task 4: Enable depth testing for the WebGL vector layer

**Files:**
- Modify: `src/ol/renderer/webgl/VectorLayer.js:406,551`
- Test: `test/browser/spec/ol/renderer/webgl/VectorLayer.test.js` (create the `describe`/`it` block if none of the existing ones cover `renderFrame`/`renderWorlds`; otherwise extend the closest existing one — check the file first)

**Interfaces:**
- Consumes: nothing new from Tasks 1-3 directly (this task is independent of the attribute wiring — depth testing must be on for the `a_zIndex`-derived depth values to have any effect, but the attribute itself works regardless).
- Produces: `WebGLHelper.prepareDraw` is now called with `enableDepth: true` for the main render, and `WebGLHelper.prepareDrawToRenderTarget` with `enableDepth: true` for the hit-detection render target.

- [ ] **Step 1: Check existing test coverage**

Run: `grep -n "prepareDraw\|renderFrame\|renderWorlds" test/browser/spec/ol/renderer/webgl/VectorLayer.test.js`

If a test already spies on `helper.prepareDraw` during `renderFrame`, extend it with the assertion in Step 2 below. If not, add a new `it` inside the closest existing `describe('renderFrame', ...)` (or create one) following that file's existing setup pattern (a `WebGLVectorLayerRenderer` instance with a stub/spy `helper`).

- [ ] **Step 2: Write the failing test**

```js
it('enables depth testing when preparing to draw', () => {
  vi.spyOn(renderer.helper, 'prepareDraw');
  renderer.renderFrame(frameState);
  assert.strictEqual(renderer.helper.prepareDraw.mock.calls[0][2], true);
});
```

(Adapt `renderer`/`frameState` variable names to whatever the surrounding `describe` block already sets up in `beforeEach`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/renderer/webgl/VectorLayer.test.js --grep "enables depth testing"`
Expected: FAIL — `prepareDraw` is called with only one argument (`frameState`), so `calls[0][2]` is `undefined`, not `true`.

- [ ] **Step 4: Enable depth testing in the source**

In `src/ol/renderer/webgl/VectorLayer.js`, in `renderFrame` (around line 406):

```js
    // draw the normal canvas
    this.helper.prepareDraw(frameState, undefined, true);
```

(This replaces `this.helper.prepareDraw(frameState);`.)

In `renderWorlds` (around line 551), for the hit-detection render target:

```js
      this.helper.prepareDrawToRenderTarget(frameState, hitRenderTarget, true, true);
```

(This replaces `this.helper.prepareDrawToRenderTarget(frameState, hitRenderTarget, true);` — the 4th argument, `enableDepth`, is new.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/renderer/webgl/VectorLayer.test.js --grep "enables depth testing"`
Expected: PASS

- [ ] **Step 6: Run the full renderer test file to check for regressions**

Run: `npx mocha --config test/browser/.mocharc.json test/browser/spec/ol/renderer/webgl/VectorLayer.test.js`
Expected: PASS (no other test asserts `prepareDraw`'s exact argument list in a way that would conflict — if one does, update it the same way as Step 4)

- [ ] **Step 7: Commit**

```bash
git add src/ol/renderer/webgl/VectorLayer.js test/browser/spec/ol/renderer/webgl/VectorLayer.test.js
git commit -m "Enable depth testing for the WebGL vector layer and hit-detection target"
```

---

## Task 5: Add a rendering-test fixture proving end-to-end z-order behavior

**Files:**
- Create: `test/rendering/cases/webgl-vector-zindex/main.js`
- Create: `test/rendering/cases/webgl-vector-zindex/expected.png` (generated, not hand-written — see Step 3)

**Interfaces:**
- Consumes: the complete feature from Tasks 1-4 (this is an end-to-end verification, not a unit test).

- [ ] **Step 1: Write the fixture**

Create `test/rendering/cases/webgl-vector-zindex/main.js`:

```js
import Feature from '../../../../src/ol/Feature.js';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import Point from '../../../../src/ol/geom/Point.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

const source = new VectorSource({
  features: [
    new Feature({geometry: new Point([-40000, 0]), group: 'a'}),
    new Feature({geometry: new Point([0, 0]), group: 'b'}),
    new Feature({geometry: new Point([40000, 0]), group: 'c'}),
  ],
});

const vector = new WebGLVectorLayer({
  source,
  style: [
    {
      filter: ['==', ['get', 'group'], 'a'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#3399CC',
        'z-index': 3,
      },
    },
    {
      filter: ['==', ['get', 'group'], 'b'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#CC3399',
        'z-index': 1,
      },
    },
    {
      filter: ['==', ['get', 'group'], 'c'],
      style: {
        'circle-radius': 60,
        'circle-fill-color': '#99CC33',
        'z-index': 2,
      },
    },
  ],
});

new Map({
  layers: [vector],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 8,
  }),
});

render({
  message:
    'Circle "a" (rule listed first, z-index 3) is drawn on top despite ' +
    'being styled by the first rule, because z-index (not rule order) now ' +
    'controls draw order in the WebGL vector renderer.',
});
```

This is the inverse of `examples/webgl-vector-zindex.js`'s current workaround-only behavior: rule order here is `a, b, c`, but z-index order is `b(1) < c(2) < a(3)`, so if this test passes it proves z-index — not rule order — now controls the result (circle "a" fully on top, circle "b" fully covered where all three overlap).

- [ ] **Step 2: Run the fixture in force mode to confirm it renders without errors**

Run: `node test/rendering/test.js --match webgl-vector-zindex --force --headless`
Expected: the run reports a missing `expected.png` (no baseline yet) rather than a script/render error. If it reports a script error, fix `main.js` before proceeding.

- [ ] **Step 3: Generate the baseline screenshot**

Run: `node test/rendering/test.js --match webgl-vector-zindex --force --fix --headless`
Expected: creates `test/rendering/cases/webgl-vector-zindex/expected.png`. Open the generated PNG and visually confirm: three overlapping circles, with the leftmost ("a", blue) fully on top of the others at every overlap, and the middle one ("b", pink) fully hidden under both neighbors where all three overlap.

- [ ] **Step 4: Re-run to confirm the test now passes against its own baseline**

Run: `node test/rendering/test.js --match webgl-vector-zindex --force --headless`
Expected: PASS (0 pixel mismatches against the freshly generated `expected.png`)

- [ ] **Step 5: Commit**

```bash
git add test/rendering/cases/webgl-vector-zindex/
git commit -m "Add rendering test fixture for WebGL vector layer z-index draw order"
```

---

## Task 6: Documentation

**Files:**
- Modify: `src/ol/style/flat.js` (JSDoc for the `z-index` property)
- Modify: `changelog/upgrade-notes.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Find and update the `z-index` JSDoc**

Run: `grep -n "z-index" src/ol/style/flat.js`

Locate the JSDoc `@property` line documenting `'z-index'` on the `Rule`/style typedef and add a note directly below it (same comment block) stating:

```
 * Note: for the WebGL renderer, z-index is implemented via GPU depth
 * testing. This is visually identical to the Canvas renderer for opaque or
 * near-opaque styles, but differs for semi-transparent overlapping
 * features at different z-index: the Canvas renderer alpha-composites all
 * overlapping layers back-to-front, while the WebGL renderer shows only
 * the nearest feature's color in the overlap region. When multiple style
 * rules are tied at the same z-index, the WebGL renderer breaks the tie by
 * rule order (the order rules appear in the style array); the Canvas
 * renderer breaks it by feature render order.
```

Adjust exact wording/indentation to match the surrounding JSDoc style found by the `grep` in this step (don't guess the format — read the actual comment block first).

- [ ] **Step 2: Add the upgrade-notes entry**

In `changelog/upgrade-notes.md`, under the `### Next Release` section, add:

```markdown
#### `z-index` support in the WebGL vector renderer

The `z-index` flat-style property is now honored by the WebGL vector
renderer (`ol/layer/WebGLVector`), fixing
[#16331](https://github.com/openlayers/openlayers/issues/16331). Draw order
now follows each feature's evaluated `z-index` value via GPU depth testing,
instead of only the order style rules appear in the style array.

This is implemented with depth testing rather than exact painter's-algorithm
compositing, so it matches the Canvas renderer's output for opaque or
near-opaque styles but not for semi-transparent overlapping features at
different z-index — see the `z-index` property documentation in
`ol/style/flat` for details.
```

- [ ] **Step 3: Verify the docs build (if applicable) and commit**

Run: `git diff --stat src/ol/style/flat.js changelog/upgrade-notes.md`
Expected: shows only the two intended additions.

```bash
git add src/ol/style/flat.js changelog/upgrade-notes.md
git commit -m "Document WebGL z-index support and its difference from Canvas"
```
