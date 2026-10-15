# Technical notes — Sketchfab viewer internals

## What we reverse-engineered

### 1. The viewer is OSG.JS
Sketchfab's web viewer is built on osgjs. Source:
https://github.com/cedricpinson/osgjs

### 2. The bundle roulette
Sketchfab serves different viewer builds to different sessions.
Some have our injection anchors (2b5a23...), some don't (da8ed87c...).
Reload until `[Ripper] patched ...` appears in the console.
This could depend if were only watching for `<head>` in the site or both `<head>` and `<body>`.

### 3. The matrix palette
`mesh._rigTransformImplementation._skinningAttribute._matrixPalette`
is the GPU skinning palette. 12 floats per bone, laid out as
3 rows of vec4 (row-major, translation in column 3).

Formula per bone (from RigTransformHardware.js):
palette[i] = invT_S→G · boneWorld · invBind · T_S→G

So the palette already IS the complete skinning matrix.
IBMs must be identity in the export.

### 4. Reading scene-graph transforms
MatrixTransform stores its transform in `.matrix` (public field,
also exposed via `getMatrix()`). Not `._matrix` — that's null on
most nodes. This was the bug that cost us the most time.

### 5. YUP correction
Sketchfab's world is Z-up. glTF is Y-up.
Apply Rx(-90) ONCE on a scene_root node above everything.
Applying per-joint breaks relative transforms.

### 6. Quaternion hemisphere
Adjacent frames can produce q and -q for the same rotation.
LINEAR interpolation then takes the long way around → joints fly
apart. Fix: flip sign when dot(prevQ, currentQ) < 0.

### 7. Animation data
Sketchfab's glTF-loading worker decodes .binz source files. The
format is proprietary — reverse-engineering it is possible but
much harder than the palette path we used.

### 8. Bundle anchors (as of Oct 2026)
- 2b5a2346934cf652f5aad6dca09f4f35-v2.js → patches 0,1,2,4
- 57542ae98812479d8666218f607e49a2-v2.js → patch 3

### 9. Known working configuration (V16, tag v0.9-working)
- YUP = Rx(-90) on scene_root
- skel_root = W_mesh (mesh's world matrix via getMatrix chain)
- IBM = identity
- Recorder reads palette + world per frame
- Export: row-major expandMat3x4, quaternion hemisphere fix

### 10. Gotchas learned the hard way
- MutationObserver scope matters. Watching `document.head` only
  catches chunks that go into head; many webpack chunks (including
  the ones with our anchors on some loads) go into body. Watching
  `document` catches both. Symptom of head-only: `patch_0/4` never
  fire even though the loader completes.
  Many webpack chunks go into body.
- readPixels per-frame freezes the viewer. Guard with
  `if (saveimagecache2[url].dataURL) return`.
- Sketchfab is an SPA. Clear `window.allmodel` when model-name
  label changes, or you accumulate duplicates.

## Animation clips and rest pose (added Oct 2026)

### 11. The animation manager
The viewer's animation manager is the entry in some ancestor node's
`_updateCallbacks` that owns `_instanceAnimations`. Walk
`allmodel[0]._parents[0]` upward (it sits on the "Scene - RootModel"
node). Useful members:
- `_instanceAnimations`: clips keyed by UID (`name`, `duration`,
  `start`, `channels`)
- `_activeAnimationList`: running instances (`.name` is the UID)
- `_startAnimations`: queued starts. `stopAllAnimation()` does NOT
  clear it. Drain it (`= {}`) before switching clips.
- `_pause`, `togglePause()`, `setSeekTime(t)`, `getSimulationTime()`

### 12. Switching and recording clips
- Switch clips by clicking `.animation-list .animation-item` (item 0
  is "Static Pose" and activates no clip). `playAnimation()` fails:
  the viewer's update gate returns early with no current clip.
- The DOM item to UID mapping differs from key order. Measure it at
  runtime by clicking each item and reading the active UID.
- Seeking while paused (`setSeekTime`) updates the palette only
  every 15-20 frames. Record in real time instead.
- Frame times come from `getSimulationTime()` (wall-clock fallback).
  The viewer defaults to "Play all" and can switch clips at the end of
  one, so samples at or past `duration` are dropped. The loop is closed
  with a copy of frame 0 at `t = duration`.
- Only add a joint's channels to a clip where that joint moves.
  Channels on every joint broke Blender NLA compositing (174 channels
  per clip down to about 15-40).
- Every joint needs a rest-pose TRS as its node default, or animated
  joints collapse to the origin when no animation plays.
- Keep the tab visible while recording. rAF stops in background tabs.

### 13. Which pose is the rest pose?
Not derivable from the data. "Static Pose" (the viewer's no-animation
state) and the first frame of a clip can differ a lot. On the Patriot
the launcher is raised in Static Pose, but the missile tubes are down
in the Battery_FR_Holder clip. `CONFIG.REST_POSE_SOURCE` picks
`'clip0'` (default) or `'static'`. The export logs how many joints
differ between the two. The Static Pose snapshot is captured by RECORD
ALL CLIPS, so use that before downloading with `'static'`.

### 14. Duplicate meshes
The viewer re-instantiates meshes when WebGL contexts are recycled.
`attachbody` merges by display name + vertex count. A mismatch in world
position is logged. `CONFIG.DEDUPE_STRICT_WORLD` keeps both, but animated
parents also move meshes, so it is off by default.

## Merged from the old handoff doc (Oct 2026)

### 15. Injection patches
Five regex patches run on the viewer bundles (anchors in section 8):
- patch_0 `/A\.renderInto\(n,E,R/g` inserts `,i`
- patch_1 `/g\.renderInto=function\(e,i,r/g` inserts `,image_data`
- patch_2 `/t\.drawArrays\(t\.TRIANGLES,0,6\)/g` inserts `,window.drawhookimg(t,image_data)`
- patch_3 `/getResourceImage:function\(e,t\){/g` inserts `e = window.drawhookcanvas(e,this._imageModel);`
- patch_4 `/(this\._stateCache\.drawGeometry\(this\._graphicContext,t\))/g` inserts `;try{window.attachbody(t);}catch(_){}`

If the console shows `init` and `panel added` but no `patched` lines, the
wrong bundle was served. Reload (the panel hints after 8 s and reloads
once after 12 s). With zero meshes in the panel, patch_4 did not fire.

### 16. Fixed gotchas (do NOT regress)
- The MutationObserver must watch `document`, not `document.head`.
- Guard per-frame pixel reads: `if (saveimagecache2[url].dataURL) return;`
- Sketchfab is an SPA. Clear `window.allmodel` when the model changes.
- The viewer runs in an iframe (URL contains `/embed`). Never add a
  top-frame-only guard.
- Vertex transform glTF evaluates: `worldVertex = YUP * W_mesh * palette[i] * restVertex`
  (the same as the OSG shader).

### 17. Texture pipeline
- Texture names come from `imagemodel.attributes.name` (sanitized,
  deduped with `_1`, `_2`), with the URL basename as a fallback.
- Textures are written to `textures/<name>.<ext>` in the ZIP and
  referenced by relative URI, not embedded.
- Per-mesh channels: `obj.stateset._textureAttributeArrayList[i][0]._object`
  has `_channels` and `_packedTextures`. AlbedoPBR maps to baseColor,
  NormalMap to normal, AOPBR to occlusion, EmissivePBR to emissive.
- UVs are `TexCoordN` with any N. The lowest non-empty one is used.
- The V flip happens once, when building the TEXCOORD_0 accessor.
  Never bake it into the parsed mesh.

### 18. Known limits
- Opacity: a separate Opacity image is merged into the base color alpha
  (`<mesh>_Alpha.png`, material `alphaMode: BLEND`), using the mask's
  luminance (black = see-through). Mask and color can share one metadata
  name, so they are matched by URL. Not yet checked in Blender.
- Vertex colors: the Sketchfab `Color` attribute (Uint8 RGBA) is written
  as `COLOR_0` (normalized UNSIGNED_BYTE). Not yet verified in Blender.
  Whether the values are sRGB or linear is unchecked. Constant base
  color factors of texture-less materials are not read (always white).
- Morph targets (Vertex_k/Normal_k deltas) and per-clip morph weights are exported, plus node TRS animation for unskinned meshes (e.g. "Sphere_1" translate). Implemented in 17.1.x; pending verification on the vertex-colour light-ball model.
- Statesets: on some models (the Kalibr) the material and its textures sit
  on the parent node named after the material, not on the mesh.
- No EmitColor channel
- Units are Sketchfab's, often cm. glTF expects metres.
- No batch download, no progress UI, and no check for a 0-mesh export

### 19. Regression values (Patriot, rest pose)
Battery mesh (M_Patriot_Battery_Tires), bone 0 palette:
`0.685 0 0.728 352.125 / 0.728 0 -0.685 446.509 / 0 1 0 -0`
Truck mesh (M_PATRIOT_Radar_Tires), bone 0 palette:
`1 0 0 0 / 0 0 -1 420.489 / 0 1 0 -0`

### 20. Test procedure
1. Hard reload the Patriot page. Expect `patched ...` lines and `panel added`; the panel shows `meshes: 7`.
2. RECORD (or RECORD ALL CLIPS), then DOWNLOAD GLB. The log should be clean through `export done`.
3. The ZIP holds the GLB (about 4 MB) and a `textures/` folder.
4. Check the GLB in gltf-viewer.donmccurdy.com and in Blender: upright, textured, animated.
5. For multi-clip, the GLB should list one animation per clip. The Patriot gives 10, with 15-18 channels each.
6. Single-clip RECORD must still work after every change.

### 21. Debug recipes
- allmodel empty: wrong bundle, see 15. Check with
  `performance.getEntriesByType('resource').filter(e => e.name.includes('2b5a23')).length`.
- Joints fly apart: the quaternion hemisphere fix (section 6) is missing.
- Model on its side: YUP must be on scene_root only, once, and skel_root must hold W_mesh.
- Joints at the origin: W_mesh was not read from the mesh node.
- Model too small or large in Blender: units are cm, scale by 0.01.
- Only the first animation plays in Blender: look in the NLA editor for a
  track overriding the action. Check the GLB in a glTF viewer first.

### 22. Code conventions
`log()`, `warn()` and `err()` (prefixed `[Ripper]`) once per significant
action, never inside per-frame or per-vertex loops. ES5 only: `var`,
function declarations, no arrows, template literals or destructuring.
Sections are separated with `// ====`.


## Auto single-clip record
RECORD with exactly one active clip restarts it and records one full loop (0..duration) automatically, reusing `recordClipRealtime`; STOP keeps the partial frames. With no manager or no active clip it falls back to the manual timer (`MAX_RECORD_SECONDS`). RECORD ALL CLIPS is greyed out when the manager has fewer than 2 clips (polled every 2 s). Verified on the vertex-colour light ball: morph targets, node translation and morph weight animation all export correctly (validator clean).

## Double sided
Sketchfab's "Single Sided" is OFF by default (both sides rendered), so `CONFIG.DOUBLE_SIDED` now defaults to true (settings checkbox "Double sided" to turn off). Cull-mode probe (`tools/probe-cullmode.js`) showed identical stateset slots (all `_value=1`) on the light ball and Kalibr with Single Sided OFF; the ON state was never captured, so there is no per-model auto-detection. Saved settings (localStorage `ripper_config_v1`) override the default: users who saved config earlier must tick the box once.

## Vertex colour space
Light ball `Color` bytes: gray ring 35,36,37 .. 91,93,96. In the Inspector's Vertex Color view the same ring reads about 56..93 (screenshot pixel picker), i.e. inside the byte range, so the viewer shows the bytes as is (sRGB, no gamma applied). glTF COLOR_0 is linear, so `CONFIG.VERTEX_COLOR_SRGB` (default true) converts RGB sRGB->linear and writes float COLOR_0, which makes glTF viewers look like Sketchfab. Untick the "Vertex color sRGB>linear" setting for raw bytes. Alpha is never converted. Confirmed visually in a glTF viewer (linear tone mapping): matches Sketchfab.

## Flat material values (texture-less channels)
Each material's flat values live in `stateset._attributeArray[0]._materialModel.attributes.channels.<Name>.attributes` (`enable`, `factor`, `color`; linear colours). Found with `tools/probe-material-factors.js` on the GoldRing model: AlbedoPBR.color [0.5,0.466,0] equals osg.Material `_diffuse` / 0.8 (DiffuseColor.factor 0.8) and matches the Inspector's Base Color view. Sketchfab's values differ from the source file (Blender showed metal 0 / rough 0.5; the viewer has metal 0.92 / rough 0.25), the export follows the viewer. `getMaterialChannels(obj)` reads them; for channels without a texture the exporter writes `baseColorFactor`, `metallicFactor`, `roughnessFactor` and `emissiveFactor` (log: `flat values from material model`). Textured channels keep factor 1. Also seen: `attributes.cullFace = 0` (Single Sided OFF); the ON value was not captured yet, a candidate for automatic doubleSided. Opacity factor is not applied.

Fix after first test on the ring: `getChannelTextureMap` can return placeholder entries (no url/name) for channels, so "has a texture" is decided by `baseColorTexture` being set (albedo) or the entry having a url/name (metalness, roughness, emission). Texture-less models have no UV in the viewer (`texCoordUnitList = []`, no TexCoord attribute), so UVs cannot be exported for them; only the artist's download has them.

## Multiple primitives, quads, scale (ring findings)
- The viewer triangulates quads, so exported meshes are triangles (inherent).
- The ring export had 2 triangle holes: only `primitives[0]` was exported. All triangle-type primitives (lists, strips, fans) are now merged into one TRIANGLES index list; log line `primitives: <mesh> n (mode x indices ...)` shows what a mesh carries. Pending verification on the ring.
- `FLAT_MR_FROM_VIEWER` setting: off writes neutral metal 0 / rough 0.5 for texture-less materials (the viewer's values differ from the artist's download).
- Scale: the ring export is exactly 100x the artist download (0.506662 vs 0.005066 high); the model is in centimetres. `CONFIG.EXPORT_SCALE` (setting "Export scale", default 1, use 0.01 for such models) scales the scene_root matrix. No automatic unit detection: the viewer exposes no unit field that we found.
- DeepSeek's idea (intercept the raw encrypted/binary model data) would be a separate project; the viewer decodes it into the same buffers we read, and may differ only in triangulation/UV availability.

## Fixes from the anime girl / tree / neon sign tests
- Zero-weight joints: any joint slot with weight 0 now points at joint 0 (validator ACCESSOR_JOINTS_USED_ZERO_WEIGHT, 38k warnings).
- Normals are normalised on export (tree normals had length ~4.8 from instance scale); morph normal deltas use the normalised data.
- Every mesh goes through the triangle conversion (lists, strips, fans merged into TRIANGLES) and degenerate triangles (repeated index, strip joins) are dropped, which removes the long zero-area edges seen in Blender on the Patriot and others.
- Emissive texture: `emissiveFactor` was left at the glTF default 0, which hides the texture; it is now [f,f,f] with f = EmitColor factor clamped to 0..1.
- Flat values: texture presence now comes from the stateset `_channelMapping` (>= 0 = textured); a flat colour is never written over a textured channel. Each material logs `texture channels [...] mapping [...]` to debug lookups.
- Opacity stored in the base colour file's alpha (log "uses one file for color and opacity"): material gets alphaMode MASK (cutoff 0.5) or BLEND depending on the viewer's Opacity `type`.
- Open: anime girl base colour textures were not attached to materials (flat colours showed); needs the new `texture channels` log lines.

## Round 3 (girl black, tree wrong texture, neon dark; tested on a slow laptop)
- Removed the "no texture assigned -> use texture 0" fallback: it painted an unrelated image (ground noise) over the whole tree. A material with no captured texture now exports plain and logs `no texture found in the capture pool`.
- New warning per material: `channels with a texture in the viewer but not in the export: ...` (stateset channel mapping says textured, lookup in the capture pool failed). Prime suspect on slow machines: textures not captured before export (TEXTURE_WAIT_SECONDS 12 may be too short).
- Disabled MetalnessPBR channel without texture now writes metallicFactor 0 (glTF default 1 renders fully metallic = black); suspected cause of the black girl.
- Identity node matrices are omitted (validator NODE_MATRIX_DEFAULT).
- Unverified: neon emission, girl black cause. Need the `material ...` log lines from those exports.

## WebGL context / RAM blow-up (round 4)
Symptom: "Too many active WebGL contexts" flood, Chrome ballooning to ~32 GB on Sketchfab with the script on.
Cause: `onbeforescriptexecute` looped over all children of the target, so every script added to <head>
(including our own patched copy) re-fetched, re-patched and re-appended every bundle script -> viewer
bundle executed repeatedly -> new GL contexts each time.
Fix: handle only `e.script`, once per bundle URL (`patchedSrc`), mark our own injected scripts (`__ripperOwn`).
Log `bundle already patched, dropping duplicate` means the guard fired.

## Round 4 test results (tree, neon, girl)
- Neon emission: confirmed working.
- Anime girl black/blue: not a bug. A separate outline mesh needs Single Sided ON; with the default
  double-sided export it covered the girl. Turn "Double sided" off in the panel for such models
  (auto detection via cullFace still open, ON value never captured).
- Tree transparency: leaves use the `AlphaMask` channel (separate image, albedo PNG has no alpha).
  Now treated like Opacity: merged into albedo alpha, alphaMode MASK cutoff 0.5
  (`_opacityKind`, `opacitySource`). Unused-texture validator info on textures 0 and 4 was these mask images.
- Merged MR looks yellow: R=255 (unused occlusion slot), G=roughness, B=metal -> yellow means rough, non-metal. Expected.
- Validator "requires tangent space" on materials with normal maps: info only (no TANGENT exported).

## Auto single sided (round 5, unverified)
`getMaterialChannels` now returns `__cull` (= `_materialModel.attributes.cullFace`). Export logs
`material X: cullFace=<v>` for every material; a non-zero value is treated as Single Sided ON and the material
is NOT marked doubleSided (setting "Auto single sided", `DOUBLE_SIDED_AUTO`, default on). Needs confirming on the
anime girl: the outline mesh should log a non-zero cullFace and the others 0. If the girl logs 0 everywhere, the flag
lives somewhere else and needs a probe.

## External review triage (round 5)
A fresh-Claude read-only review gave 30 findings; each was checked against the code.
Fixed: bundle fetch error handling (original script keeps running on failure), RE lastIndex reset, no closing
blend frame on cancelled/truncated clip records, unguarded rest0 for late meshes, vanished clip list item, 16-bit
index limit (< 65535), width-0 loop hang, point mode no longer treated as triangles, empty/out-of-range indices
dropped, texture URIs percent-encoded, images only listed when the file exists, config values type/finite checked,
reload-loop guard when sessionStorage rejects writes, flat colour/emission clamped to 0..1, RECORD ALL CLIPS clears old
single recording, export re-entry and export-during-recording guard, zip name sanitised plus .catch.
Deferred (judged low value or risky without a live test): model-switch state reset (#1), mid-recording mesh
carry-forward (#5), URL-tail texture lookup / MR merge by URL (#7, #8), duplicate-mesh-name materials (#9), CLIP_FPS throttling (#13),
memory release of bitmaps/dataURL (#12), morph target index remap (#19), morph min/max float32 (#20), mirrored-scale decompose (#22),
O(n^2) parent search (#25), manager cache re-validation (#15), normal/UV length guards (#18).
