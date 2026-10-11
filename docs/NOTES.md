# Technical notes — Sketchfab viewer internals

## What we reverse-engineered

### 1. The viewer is OSG.JS
Sketchfab's web viewer is built on osgjs. Source:
https://github.com/cedricpinson/osgjs

### 2. The bundle roulette
Sketchfab serves different viewer builds to different sessions.
Some have our injection anchors (2b5a23...), some don't (da8ed87c...).
Reload until `[Ripper] patched ...` appears in the console.
This could depend if were only watching for <head> in the site or both <head> and <body>.

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
Light ball `Color` bytes: gray ring 35,36,37 .. 91,93,96. In the Inspector's Vertex Color view the same ring reads about 56..93 (screenshot pixel picker), i.e. inside the byte range, so the viewer shows the bytes as is (sRGB, no gamma applied). glTF COLOR_0 is linear, so `CONFIG.VERTEX_COLOR_SRGB` (default true) converts RGB sRGB->linear and writes float COLOR_0, which makes glTF viewers look like Sketchfab. Untick the "Vertex color sRGB>linear" setting for raw bytes. Alpha is never converted. Pending visual confirmation.
