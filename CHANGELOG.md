# Changelog

## v1.1.0

### New
- Records one full loop of the active clip automatically when you click RECORD.
- Exports material values for models without textures: base color, metalness, roughness, emission and opacity.
- Exports alpha mask (cutout) materials and opacity images without a base color image.
- Follows the Single Sided setting of each material.
- Exports bones with non-uniform scale and shear without data loss (helper node per sheared joint).
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
