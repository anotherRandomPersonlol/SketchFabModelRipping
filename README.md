# Sketchfab Model Exporter

> **For personal archival and educational use only.**  
> Respect content creators' copyright and Sketchfab's terms of service.  
> Do not use this tool to redistribute models you don't own the rights to.

A Tampermonkey userscript that exports Sketchfab models as GLB with skeleton,
animations, and textures preserved. For personal archival and 3D research.

## Features
- GLB export with skeleton and skinning
- Animation recording: one full loop of the active clip, or RECORD ALL CLIPS for multi-clip models
- Unskinned (node) animation and morph target weights
- PBR textures: base colour, normal, merged metallic-roughness, emissive, occlusion, opacity and alpha mask (cutout)
- Flat material values for texture-less models (colour, metalness, roughness, emission)
- Vertex colours (sRGB converted to linear), multiple primitives per mesh, quads and strips
- Double sided follows each material's Single Sided flag (optional override)
- Settings panel (gear icon): record FPS (every frame, 60, 30, 24, 15), export scale, double sided, vertex colour conversion and more

## Install
1. Install Tampermonkey
2. Create a new userscript and paste `src/Sketchfab-ripper.js`
3. Open any Sketchfab model page

## Usage
1. Wait for the panel to appear (top-right)
2. Animated models: press RECORD, then STOP. Or leave it: the export records one loop of the active clip automatically
3. Several clips: press RECORD ALL CLIPS
4. Click DOWNLOAD GLB (a zip with the GLB and textures)

## Known limitations
- Textures are only captured when the viewer draws them. Wait for the model to finish loading; slow machines may need a longer texture wait
- Tangents are not exported (viewers generate them from the normal map)
- Reload the page if the panel doesn't appear on first load
- Keep the Sketchfab tab visible while recording. A hidden or minimised tab pauses rendering, so frames are skipped and clips can come out short

## Credits
- Original injection framework: Risk
- Palette / OSG hierarchy work: anotherRandomPersonlol

## Disclaimer
This tool is intended for **personal archival and educational purposes**.
Users are responsible for complying with:
- The copyright of the model creators
- [Sketchfab's Terms of Service](https://sketchfab.com/terms)
- Any applicable local laws regarding digital content

The author does not condone or encourage redistribution of copyrighted content.

**Requires [Tampermonkey](https://www.tampermonkey.net/) or a compatible userscript manager.**

## License
MIT — see [LICENSE](LICENSE)
