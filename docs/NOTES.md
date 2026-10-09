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