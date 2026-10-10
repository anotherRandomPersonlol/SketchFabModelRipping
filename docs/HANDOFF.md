=== SKETCHFAB MODEL EXPORTER — COMPLETE HANDOFF ===

STATUS (Oct 2026): this document is the original v0.9.x handoff.
Multi-clip recording and export is DONE (v17+). Its learnings are in
docs/NOTES.md sections 11-14. Keep this file for the regression
values and the fixed-gotchas list; ignore the version numbers and the
"AFTER: Multiple animation clips" plan below.

## PROJECT OVERVIEW
Tampermonkey userscript that exports Sketchfab models as GLB with
skeleton, recorded animations, and captured textures. Currently
around v0.9.2-config.

## LOCATIONS
- Local repo:  C:\Users\pc\Desktop\SketchfabModelRipping
- GitHub:      https://github.com/anotherRandomPersonlol/SketchFabModelRipping
- Userscript:  src/Sketchfab-ripper.js  (single file, ~2000 lines)
- osgjs dump:  C:\Users\pc\Desktop\osgjs\   (reference source files)
- Test model:  https://sketchfab.com/3d-models/mim-104-patriot-system-a7d97cddfe8a46e189cd325026029af2

## GIT STATE
Tags (safety nets):
  v0.9-working     = first fully-working version (GLB + 1-clip animation)
  v0.9.1-retry     = added reload-on-failure detection
  v0.9.2-config    = runtime config panel (MAY OR MAY NOT BE COMMITTED —
                     verify with `git tag` before assuming)

Revert a file to a known-good version:
  git checkout v0.9-working -- src/Sketchfab-ripper.js

Typical commit cycle:
  git add src/Sketchfab-ripper.js
  git commit -m "..."
  git push
  git tag -a vX.Y.Z-name -m "..."
  git push --tags


================================================================
CRITICAL TECHNICAL DISCOVERIES
(took multiple days — do NOT re-discover)
================================================================

### 1. The viewer is osgjs
https://github.com/cedricpinson/osgjs
All internal node types (Bone, MatrixTransform, Skeleton,
RigGeometry, SkinningAttribute) inherit from osg object model.

### 2. MatrixTransform stores transform in `.matrix`
NOT in `._matrix`. Reading `._matrix` on most nodes returns null.
This is the single bug that cost the most time. Correct read order:

    function getLocalNodeMatrix(node) {
        if (!node) return identityMat4();
        if (typeof node.getMatrix === 'function') {
            var m = node.getMatrix();
            if (m && m.length === 16) return Array.prototype.slice.call(m);
        }
        if (node.matrix && node.matrix.length === 16) {
            return Array.prototype.slice.call(node.matrix);
        }
        if (node._matrix && node._matrix.length === 16) {
            return Array.prototype.slice.call(node._matrix);
        }
        return identityMat4();
    }

Use this to walk parents:

    function computeWorldMatrix(obj) {
        var chain = [];
        var curr = obj;
        var guard = 0;
        while (curr && guard++ < 64) {
            chain.unshift(getLocalNodeMatrix(curr));
            curr = curr._parents && curr._parents[0];
        }
        var world = identityMat4();
        for (var i = 0; i < chain.length; i++) world = mat4Mul(world, chain[i]);
        return world;
    }

### 3. The matrix palette (GPU skinning)
Path: mesh._rigTransformImplementation._skinningAttribute._matrixPalette
Type: Float32Array
Format: 12 floats per bone, 3 rows of vec4, row-major

    [r00 r01 r02 tx]
    [r10 r11 r12 ty]
    [r20 r21 r22 tz]

Per OSG source (RigTransformHardware.js):
    palette[i] = invT_S→G · boneWorld · invBind · T_S→G

So palette already IS the complete skinning matrix. In GLB export,
inverseBindMatrices MUST be identity.

Expand 12 floats to column-major 4x4:

    function expandMat3x4(pal, boneIdx) {
        var b = boneIdx * 12;
        return [
            pal[b + 0], pal[b + 4], pal[b + 8], 0,   // col 0
            pal[b + 1], pal[b + 5], pal[b + 9], 0,   // col 1
            pal[b + 2], pal[b + 6], pal[b + 10], 0,  // col 2
            pal[b + 3], pal[b + 7], pal[b + 11], 1   // col 3 = translation
        ];
    }

### 4. Sample palette values for regression testing
If you need to verify the palette reader still works, these are
the exact values from the Patriot test model at rest pose.

Battery mesh (M_Patriot_Battery_Tires), bone 0:
    0.685, 0.000, 0.728, 352.125,
    0.728, 0.000, -0.685, 446.509,
    0.000, 1.000, 0.000, -0.000

Truck mesh (M_PATRIOT_Radar_Tires), bone 0:
    1.000, 0.000, 0.000, 0.000,
    0.000, 0.000, -1.000, 420.489,
    0.000, 1.000, 0.000, -0.000

If your reader produces these from the same model, it's correct.

### 5. YUP correction (Z-up → Y-up)
Sketchfab world is Z-up. glTF is Y-up.
Apply Rx(-90) ONCE on a single scene_root node above everything.

    var YUP = [
        1, 0, 0, 0,
        0, 0, -1, 0,
        0, 1, 0, 0,
        0, 0, 0, 1
    ];

NEVER apply per-joint — that breaks relative transforms between
joints and causes disassembly.

### 6. Quaternion hemisphere fix
Adjacent frames can produce q and -q (same rotation).
LINEAR interpolation then takes the long way around → joints
fly apart at render time.

Fix inside the recording loop:

    if (prevQ) {
        var dot = d.rotation[0]*prevQ[0] + d.rotation[1]*prevQ[1]
                + d.rotation[2]*prevQ[2] + d.rotation[3]*prevQ[3];
        if (dot < 0) {
            d.rotation[0] = -d.rotation[0];
            d.rotation[1] = -d.rotation[1];
            d.rotation[2] = -d.rotation[2];
            d.rotation[3] = -d.rotation[3];
        }
    }
    prevQ = d.rotation.slice();

### 7. Working GLB export recipe (V16)
For each skinned mesh:

  a) Compute W_mesh = computeWorldMatrix(obj)   // via getMatrix chain
  b) Create skel_root node with matrix = W_mesh
  c) Create N joint nodes as children of skel_root
  d) IBM accessor = identity matrices (N × 16 floats)
  e) Mesh node's own `matrix` is DELETED (glTF ignores it when skin is set)
  f) Joint TRS comes from decompose(expandMat3x4(palette, i))
  g) Above everything, one scene_root with matrix = YUP

Vertex transform chain glTF evaluates:
  worldVertex = YUP · W_mesh · palette[i] · restVertex

This matches what OSG's shader does.

### 8. Injection anchors (as of Oct 2026)
Two bundles contain the anchors:
  2b5a2346934cf652f5aad6dca09f4f35-v2.js → patches 0,1,2,4
  57542ae98812479d8666218f607e49a2-v2.js → patch 3

Five patch targets:

  patch_0  at  /A\.renderInto\(n,E,R/g
           inserts ",i"

  patch_1  at  /g\.renderInto=function\(e,i,r/g
           inserts ",image_data"

  patch_2  at  /t\.drawArrays\(t\.TRIANGLES,0,6\)/g
           inserts ",window.drawhookimg(t,image_data)"

  patch_3  at  /getResourceImage:function\(e,t\){/g
           inserts "e = window.drawhookcanvas(e,this._imageModel);"

  patch_4  at  /(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g
           inserts ";try{window.attachbody(t);}catch(_){}"

### 9. Fixed gotchas (do NOT regress)
- MutationObserver MUST watch `document`, not `document.head`.
  Many webpack chunks inject into body. Head-only missed patch_4
  on some loads and broke allmodel collection.
  Observe line:
    obs.observe(window.document, { childList: true, subtree: true });

- readPixels per frame FREEZES the viewer. Guard:
    if (saveimagecache2[url].dataURL) return;
  This skips re-reading a texture we already captured.

- Sketchfab is an SPA. When navigating between models, clear
  window.allmodel or duplicates accumulate. Watch the
  .model-name__label element for changes.

- Viewer runs inside an iframe (URL contains /embed). Do NOT
  have a top-frame-only guard like:
    if (window.self !== window.top) return;
  because the viewer lives in the iframe, not the top frame.

- The `if (n.tagName === 'SCRIPT')` early-reject in the observer
  is fine — that's cheap. The dangerous thing was changing WHICH
  document we observed, not filtering node types.


================================================================
CURRENT FILE STRUCTURE
================================================================

================================================================
CHANGES SINCE v0.9.2-config  (as of tag v0.9.7-clean)
================================================================

Read this FIRST — the rest of the doc describes the state at
v0.9.2. Several "known limits" below are now false.

### Done: texture capture pipeline (was "pending" in original doc)

1. **Texture names come from Sketchfab metadata.**
   In `drawhookcanvas`, `imagemodel.attributes.name` yields the
   artist's semantic name (e.g. "Patriot_Radar_Body_D_Desert").
   A helper `pickTextureName(imagemodel, url)` sanitizes it and
   falls back to the URL basename if metadata is missing.
   Deduped via `_usedTextureNames` so `_1`, `_2` suffixes are
   appended on collision.

2. **Textures are written to `textures/` as separate files, not
   embedded data: URIs.** This is deliberate — Roblox and other
   pipelines need standalone image files. The GLB references them
   as relative `images[].uri = "textures/<name>.<ext>"`.
   Source format is preserved (JPEG source → JPEG output at q=0.92,
   PNG source → PNG).

3. **Materials now reference the correct textures.**
   Per-mesh texture info lives at:
     obj.stateset._textureAttributeArrayList[i][0]._object
   That's an osg.Texture. It has:
     _channels       = ['AlbedoPBR','NormalMap','AOPBR', ...]
     _packedTextures = { AlbedoPBR: {texture: {...}},
                         NormalMap: {texture: {...}}, ... }
   Each `packedTextures.<channel>.texture` has:
     _image._url                                  <- source URL
     _imageModel.attributes.name                  <- semantic name
   Helper `getChannelTextureMap(obj)` returns
   { channelName: {url, name} }.

   In the export loop:
     AlbedoPBR   → pbrMetallicRoughness.baseColorTexture
     NormalMap   → normalTexture
     AOPBR       → occlusionTexture
     EmissivePBR → emissiveTexture
   (EmitColor is Sketchfab's alternate emissive channel — NOT
   currently wired, see Part D below.)

4. **UVs are per-mesh TexCoordN with arbitrary N.**
   Sketchfab assigns TexCoord0, TexCoord3, TexCoord6, etc.
   depending on the source model. `parseobj` now scans for any
   /^TexCoord(\d+)$/ key and picks the lowest numbered non-empty
   one.

5. **V-flip for glTF.** Sketchfab's osgjs uses bottom-left UV
   origin; glTF uses top-left. Export flips V (index 1 of each
   UV pair) exactly once when building the TEXCOORD_0 accessor.
   This is export-local — do NOT bake it into the parsed mesh,
   or a future FBX path would double-flip.

### Still known limits (updated)

- Single-clip animation export (multi-clip is the next big task)
- No metallicRoughnessTexture — see Part D below
- No EmitColor handling (Sketchfab's other emissive channel key)
- No `Opacity` handling (M_HEMTT_Glass uses it — currently
  renders opaque)
- Scale: units are Sketchfab's (often cm, glTF expects m)
- No multi-model batch
- No progress UI during export
- No validation before export (0-mesh exports succeed silently)

### Current file structure additions

New helpers (all in the texture section, before drawhookcanvas):

  _usedTextureNames         object (module scope)
  sanitizeTextureName(raw)  -> string
  deriveTextureName(url)    -> string   (URL basename fallback)
  pickTextureName(im, url)  -> string   (metadata preferred)
  normalizeUrl(u)           -> string   (strip query/#/trailing /)
  getChannelTextureMap(obj) -> { channel: {url, name} }

New state in downloadGLB:

  matsChannelInfo    { materialIndex: { channel: {url, name} } }
  textureUrlToIndex  normalized URL → images[] index
  textureNameToIndex sanitized name → images[] index
  findTexIdx(info)   resolves {url,name} to images[] index

In `parseobj`: UV lookup replaced with TexCoordN regex scan.

In UV accessor build: V-flip loop before addBV.

In ZIP packing: textures go under `textures/<name>.<ext>`.

### Regression test values (unchanged from v0.9.2 section 4)

Battery mesh bone 0 palette:
  0.685, 0.000, 0.728, 352.125,
  0.728, 0.000, -0.685, 446.509,
  0.000, 1.000, 0.000, -0.000

Truck mesh bone 0 palette:
  1.000, 0.000, 0.000, 0.000,
  0.000, 0.000, -1.000, 420.489,
  0.000, 1.000, 0.000, -0.000

### Test procedure (updated)

1. Open Patriot in browser with userscript installed. Hard reload.
2. Console: expect `[Ripper] patched ...` lines + `panel added`.
3. Panel: `meshes: 7`.
4. Record 2s. STOP. Download.
5. Console: expect clean log through `export done`.
   NO `=== material wiring ===` or `=== texture pool ===` spam
   (those debug blocks were removed in v0.9.7).
6. Extract ZIP. Should contain:
   - `MIM-104 Patriot System.glb`  (~3.4 MB)
   - `textures/` folder with ~27 semantic-named PNG/JPG files
7. Open GLB in https://gltf-viewer.donmccurdy.com/ with the
   textures/ folder alongside it, or drag the whole folder.
8. Expected: textured, upright, animates, windshield glass
   correctly mapped.

Top of file:
  // ==UserScript== metadata
  window.allmodel, window.skins, recording state
  CONFIG object (loads from localStorage on init)
  YUP constant

Math section:
  identityMat4()
  matToArr()
  mat4Mul()
  getLocalNodeMatrix()  ← the critical one
  computeWorldMatrix()
  decomposeMat4()

Texture capture:
  window.drawhookcanvas(e, imagemodel)   ← captures texture metadata
  window.drawhookimg(gl, t)              ← reads pixels (guarded)

Node capture:
  window.attachbody(obj)                 ← called from patch_4

Recorder:
  snapshotFrame()                        ← captures world + palette
  startRecording()
  stopRecording()

UI:
  addbtnfunc()                           ← floating panel
  Config panel (opened via ⚙ icon)
  Reload-retry timer (fires at 8s/12s if anchors missed)

Export:
  downloadGLB()                          ← the big one
    - builds nodes[] from allmodel
    - builds meshes, accessors, bufferViews, materials
    - skins + IBM (identity)
    - animation from recordedFrames
    - packs GLB
    - zips GLB + texture PNGs

Injection:
  installInterceptor()                   ← MutationObserver
  window.onbeforescriptexecute handler   ← runs the 5 patches


================================================================
REMAINING FEATURES — DETAILED PLAN
================================================================

### NEXT: Texture matching + smaller file size  (1-2 hours)

PROBLEM:
  Every material gets assigned texture index 0. So the GLB looks
  monochrome in Blender even though the model is fully textured
  in the viewer. Also all textures are embedded as data: URIs,
  bloating the ZIP by ~33%.

PART A — capture texture names properly
  In drawhookcanvas, saveimagecache2[url].name is currently set
  to imagemodel.attributes.name (the MESH name, wrong).
  Should be derived from the URL instead.

  Change from:
    var filename_image = imagemodel.attributes.name;
  Change to:
    var m = e.url.match(/\/([^\/]+?)(?:\.jpeg|\.jpg|\.png)?(?:\?|$)/);
    var filename_image = m ? decodeURIComponent(m[1]) : 'texture';

  Then texture files in the ZIP will have names like
  HEMTT_Body_Desert_BaseColor.png instead of
  M_PATRIOT_Battery_Body.png.

PART B — attach correct texture to each material
  Walk obj.stateset._uniformList. Find uniforms whose name
  contains 'colorMap', 'diffuseMap', 'baseColorTexture',
  or similar. uniform._value is a Texture object.
  Trace Texture._image → gives a URL that matches a key in
  saveimagecache2.

  Build a map: materialName → textureURL
  In the export loop, set:
    mat.pbrMetallicRoughness.baseColorTexture = {
        index: textureKeyToIndex[textureURL]
    }

  Fallback: if no uniform match, keep current behavior
  (all textures) so nothing regresses.

PART C — smaller file size (separate files instead of data: URIs)
  Currently images[] entries look like:
    { uri: 'data:image/png;base64,...' }
  Instead:
    - When packing the ZIP, add each captured texture as
      textures/NAME.png
    - In glTF, set images[].uri = 'textures/NAME.png'
    - GLB container supports external references (though for a
      pure GLB this needs the separate .bin — alternative:
      reference them from the ZIP alongside the GLB, standard
      glTF has an option for external resources)
  
  Simpler approach that keeps single-file GLB: keep data: URIs
  but deduplicate identical textures by content hash. Often the
  same PNG is captured multiple times because it's used by
  multiple materials.

  Even simpler: after capture, downscale textures to 1024×1024
  max via canvas. Saves 60-80% of size for typical Sketchfab
  uploads which are often 2048.

### DONE: Multiple animation clips  (see docs/NOTES.md 11-14)
(The plan below is kept for history. It was implemented differently:
clips are discovered and switched by clicking the DOM list, and
recorded in real time.)

CURRENTLY:
  window.recordedFrames is a flat array of { time, meshes: [...] }
  The exporter creates one animations[0] with all channels.

NEEDED:
  - Discover available clips. Options:
      a) DOM: sketchfab bottom bar has tabs per animation
         (look for .animation-tab or similar in DevTools)
      b) Object: viewer's animation manager lives somewhere in
         the scene graph; probe allmodel[0] ancestors for
         _animations or _animManager
  - For each clip:
      * call viewer's setClip(name) or click the tab
      * wait for transition
      * startRecording()
      * wait CONFIG.MAX_RECORD_SECONDS
      * stopRecording()
      * push { name, frames } to clips[]
      * reset window.recordedFrames = []
  - Refactor exporter to iterate clips and emit one animation
    per clip:
      gltf.animations = clips.map(clip => ({ name, samplers, channels }))
  - Sampler inputs (times) can differ per clip; that's fine.

BEST HANDED TO FRESH CLAUDE with:
  - This handoff doc
  - osgjs source at C:\Users\pc\Desktop\osgjs\
  - Actual current file
  - Prompt: "Extend the recorder in this userscript to record N
    animation clips from a Sketchfab viewer and export each as a
    separate entry in gltf.animations[]. The viewer uses osgjs.
    Give me a concrete diff, not a rewrite."

### LAST (optional): Batch download  (1+ day)
  - Queue of URLs in localStorage
  - Auto-navigate between queued pages
  - Merge all outputs into one ZIP
  - Highest risk, most likely to break on next Sketchfab change.
  - Do only if specifically requested.

### MAYBE LATER: something else
  - Auto-scale detection (Sketchfab is often in cm, glTF is m)
  - Better material export (currently PBR stub is very plain)
  - Progress bar for export


================================================================
TEST PROCEDURE (for verifying any change)
================================================================

1. Open any Sketchfab model page in a browser with the userscript
   installed. Hard-reload with Ctrl+Shift+R.

2. Watch console for (good output):
     [Ripper] init
     [Ripper] patched 2b5a...-v2.js → patch_0,patch_1,patch_2,patch_4
     [Ripper] patched 57542...-v2.js → patch_3
     [Ripper] panel added

   Bad output (something is broken upstream):
     [Ripper] init
     [Ripper] panel added
     (no "patched" lines)

   If you see the bad output, wait 8 seconds. The panel will show
   "⚠ no anchors — reload page". Something in the injection or
   observer is broken. Check:
     - installInterceptor runs BEFORE onbeforescriptexecute assignment
     - obs.observe uses window.document
     - The 5 regex patterns in RE are unchanged

3. Verify the panel shows "meshes: 7" (or whatever the model has).
   Zero means attachbody wasn't called — patch_4 failed.

4. RECORD for 2 seconds. Status should show frames counting up.

5. STOP. Then DOWNLOAD GLB.

6. Console should print:
     [Ripper] export started
     [Ripper] skinned mesh: ... (one per mesh)
     [Ripper] skin N for mesh ... → M joints, K animated
     [Ripper] built scene: nodes=... meshes=7 skins=7 animFrames=...
     [Ripper] export done: <model>.zip

7. Extract the ZIP. Inside should be:
     <model>.glb
     <texture>.png (multiple)

8. Load the GLB in:
     https://gltf-viewer.donmccurdy.com/
   or Blender.

   Expected:
     - Upright model
     - Textures applied (currently: monochrome, texture matching pending)
     - Animation plays when timeline is scrubbed


================================================================
DEBUG RECIPES
================================================================

### "allmodel is empty"
  Open console on the viewer iframe (DevTools context dropdown).
  If patch_4 didn't fire:
    - The bundle served didn't have the anchors
    - Or the observer missed the script
  Confirm with:
    performance.getEntriesByType('resource')
      .filter(e => e.name.includes('2b5a23'))
      .length
  If 0 → wrong bundle. Reload. If still 0 after 5 loads, something
  broke in the injection.

### "Joints fly apart during animation"
  Quaternion hemisphere issue. Verify the prevQ / dot / negate
  logic is present in the animation recording loop.

### "Model on its side / rotated wrong"
  YUP misapplied. Confirm:
    - YUP is on scene_root, not on joints
    - Only ONE YUP node exists
    - skel_root has W_mesh, not identity

### "Joints at origin"
  W_mesh wasn't read from the mesh node. Confirm computeWorldMatrix
  is called on the mesh object and its result is being set as
  skel_root's matrix.

### "Textures missing in Blender"
  Expected as of now. All textures ARE in the ZIP as PNGs.
  Texture-to-material matching is the next feature.

### "Blender shows model too small / too big"
  Known. Sketchfab often uses centimeters. Fix in Blender: scale
  object 0.01, apply transform. Or export with unit conversion
  (future feature).


================================================================
CODE CONVENTIONS
================================================================

Logging:
  log()   — normal info, prefixed [Ripper]
  warn()  — warnings, prefixed [Ripper]
  err()   — errors, prefixed [Ripper]

All prefixed by TAG = '[Ripper]'. Every significant action logs
one line. Avoid logging inside tight loops (per-frame, per-vertex).

Style:
  - No ES6+ in the userscript itself (compatibility with older
    Tampermonkey builds)
  - var, not let/const
  - function declarations, not arrow functions
  - Explicit var declarations, no implicit globals

Names:
  snake_case for state (saveimagecache2, recordedFrames)
  camelCase for functions (downloadGLB, addbtnfunc, attachbody)

Section separators:
  // ============ or // =================
  followed by a one-line title, then blank line


================================================================
KNOWN LIMITS
================================================================

- Single-clip animation export
- Textures not assigned to materials
- All-in-one GLB (data: URIs) — large file size
- Scale: units are Sketchfab's (often cm, glTF expects m)
- No multi-model batch
- No progress UI during export
- No validation before export (0-mesh exports succeed and create
  an empty GLB)
- Requires a page reload if the wrong bundle was served

================================================================
END HANDOFF