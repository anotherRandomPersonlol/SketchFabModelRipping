# Sketchfab Model Exporter

> **For personal archival and educational use only.**  
> Respect content creators' copyright and Sketchfab's terms of service.  
> Do not use this tool to redistribute models you don't own the rights to.

A Tampermonkey userscript that exports Sketchfab models as GLB with skeleton,
animations, and textures preserved. For personal archival and 3D research.

## Features
- GLB export with skinning
- Animation recording (currently single-clip)
- Texture capture as separate PNGs

## Install
1. Install Tampermonkey
2. Click install link / paste userscript
3. Open any Sketchfab model page

## Usage
1. Wait for the panel to appear (top-right)
2. Optional: RECORD then STOP
3. Click DOWNLOAD GLB

## Known limitations
- Only one animation clip per export (multi-clip planned)
- Reload the page if the panel doesn't appear on first load

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
