# Changelog

## v1.3.1

### Changed
- The script has an icon in Tampermonkey and on Greasy Fork: the Sketchfab logo (`docs/icon64.png`), used as described on the Sketchfab press page.
- README: the script is not an official Sketchfab tool.

## v1.3.0

### Changed
- The script uses modern JavaScript syntax: `let` and `const`, arrow functions, template literals. Exports are the same as in v1.2.1 (tested on 5 models: static, rigged with 26 clips, vertex colours and morph targets). `tools/migration/` has the converter and the checker that compares the new code with the old code.

## v1.2.1

### Fixed
- A joint that does not move in a clip, but is held away from the rest pose, now keeps that pose in the clip. Before, a glTF player showed the rest pose for that joint, so the clip looked wrong (for example Sit1 of "Simple rigged and animated character"). The same fix applies to moving meshes without a skin and to morph weights.

## v1.2.0

### New
- New setting: Keep still clips (off by default). A clip in which no joint moves (a pose clip) is exported as a pose of the skeleton, with two equal keys at the start and the end of the clip. With the setting off, such clips are left out of the file, as before.
- README: list of tested models.

## v1.1.4

### Changed
- The script header has a `@namespace` line (Greasy Fork needs it). Tampermonkey sees this as a new script, so a user who installed an older version can have two copies. Remove the old copy.

## v1.1.3

### Changed
- The script header has no fixed update address. Tampermonkey updates the script from the place that you installed it from (GitHub or Greasy Fork).

## v1.1.2

### New
- New setting: Reduce keyframes (on by default). Leaves out animation keys that the keys before and after them already give, within a small tolerance. Animated exports are about half as large. Turn it off if an animation looks wrong.

### Changed
- The zip file is compressed. Textures are stored as they are, because PNG and JPEG are already compressed.
- Every setting has a tooltip that tells what it does.
- The script header has `@license MIT`.

### Fixed
- The GLB no longer has an empty node for the skipped wireframe overlay.
- The GLB no longer has unused time data for clips that are not exported.

## v1.1.1

### Fixed
- The export no longer contains the wireframe overlay of the viewer as a second mesh. It looked like a stretched copy of the model made of lines, and it did not move with the animation.

### Changed
- The log names the clips that are not exported because they do not move.
- The script header uses `@match` and not a regular expression in `@include`. The script runs on the same pages as before.

## v1.1.0

### New
- Records one full loop of the active clip automatically when you click RECORD.
- Exports material values for models without textures: base color, metalness, roughness, emission and opacity.
- Exports alpha mask (cutout) materials and opacity images without a base color image.
- Follows the Single Sided setting of each material.
- Exports bones with non-uniform scale and shear without data loss, also in Blender.
- Keeps expression switches (bones scaled to zero) instant, as in the viewer.
- New settings: Record FPS, Export scale, Auto single sided, Drop strip slivers, Vertex color sRGB>linear, Flat metal/rough from viewer.
- Issue forms for bug reports and feature requests.

### Fixed
- The viewer bundle ran many times, which used all WebGL contexts and a very large amount of memory.
- Large models lost geometry because separate chunks were merged as duplicates.
- Long thin "stripes" between separate parts of strip geometry.
- Missing triangles in meshes with more than one primitive.
- Textures from a different material, unused textures and duplicate merged textures in the zip.
- Texture file names with spaces or special characters broke the links in the GLB.
- Zero and mirrored bone scales were exported wrong.
- Many smaller problems that two code reviews found (index limits, export during recording, settings validation, memory use).

### Changed
- Script name is now "Sketchfab Ripper", version 1.1.0. The file is now `src/Sketchfab-ripper.user.js`, so Tampermonkey can install it from a link and update it.
- Quieter console log. Each export still lists the materials, so you can paste the log in a bug report.

## v1.0.0
- Multi-clip recording (RECORD ALL CLIPS).
