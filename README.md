# Sketchfab Ripper

> **For personal archival and educational use only.**
> Respect the copyright of the model creators and the Sketchfab terms of service.
> Do not use this tool to share models that you do not have the rights to.

Sketchfab Ripper is a userscript for Tampermonkey. It exports the model that the Sketchfab viewer shows as a GLB file, with the skeleton, the animation and the textures.

## Features

- GLB export with skeleton and skinning.
- Animation recording: one full loop of the active clip, or all clips of a multi-clip model.
- Animation of unskinned parts and of morph target weights.
- PBR textures: base color, normal, metallic-roughness, emission, occlusion, opacity and alpha mask (cutout).
- Material values for models without textures: base color, metalness, roughness, emission and opacity.
- Vertex colors, multiple primitives in one mesh, triangle strips and fans.
- Single-sided and double-sided materials, the same as in the viewer.
- Bones with non-uniform scale and shear, exported without data loss.
- A settings panel (gear icon) that keeps your settings.

## Requirements

- A desktop browser, for example Chrome, Brave, Edge or Firefox.
- [Tampermonkey](https://www.tampermonkey.net/) or a compatible userscript manager.

## Install

1. Install Tampermonkey in your browser.
2. Open this link: [Sketchfab-ripper.user.js](https://raw.githubusercontent.com/anotherRandomPersonlol/SketchFabModelRipping/main/src/Sketchfab-ripper.user.js).
3. In the Tampermonkey page that opens, click **Install**.

Tampermonkey checks the link for new versions and updates the script.

If the install page does not open:

1. Open [`src/Sketchfab-ripper.user.js`](src/Sketchfab-ripper.user.js) and copy all the text.
2. In Tampermonkey, click **Create a new script**.
3. Delete the template text and paste the script.
4. Save the script.

## Export a model

1. Open a model page on Sketchfab.
2. Wait until the model is fully visible and the **MODEL RIPPER** panel shows (top right).
3. If the model has animation, do one of these steps:
   - To record the active clip, click **RECORD**. The script records one full loop and stops.
   - To record all clips, click **RECORD ALL CLIPS**.
4. Wait until the recording stops.
5. Click **DOWNLOAD GLB**.

The download is a zip file. It contains the GLB file and a `textures` folder.

If you do not record, the export contains the model in its current pose.

> Keep the Sketchfab tab visible while you record. The browser pauses a hidden or minimized tab, and the recording then loses frames.

## Settings

Click the gear icon in the panel. The script keeps your settings for the next visit.

| Setting | Default | What it does |
|---|---|---|
| Max seconds | 12 | Stops a manual recording after this time. |
| Record FPS | Max | Frames per second in the recording. Lower values make smaller files. |
| Auto-reload | On | Reloads the page one time if the script cannot connect to the viewer. |
| Double sided | On | Marks materials as double-sided, as in the viewer. |
| Auto single sided (viewer flag) | On | Keeps a material single-sided if the viewer shows it single-sided. |
| Drop strip slivers (stripes) | On | Removes long thin triangles that connect separate parts. |
| Vertex color sRGB>linear | On | Converts vertex colors to the color space that glTF uses. |
| Flat metal/rough from viewer | On | Uses the metalness and roughness values of the viewer for materials without textures. |
| Export scale | 1 | Multiplies the size of the model. Use 0.01 for a model in centimeters. |
| MR format | JPEG | File format of the merged metallic-roughness textures: JPEG (small) or PNG (lossless). |
| Rest pose | Clip frame 0 | Sets the rest pose of the skeleton: the first recorded frame or the Static Pose of the viewer. |

## Open the export

- **glTF viewer**: drop the GLB file on [gltf-viewer.donmccurdy.com](https://gltf-viewer.donmccurdy.com/). This viewer shows the export exactly.
- **Blender**: use **File > Import > glTF 2.0** with the default options.
- **Validator**: drop the GLB file on the [glTF validator](https://github.khronos.org/glTF-Validator/) to check it.

## Known limitations

- The script gets a texture only when the viewer draws it. Wait until the model is fully visible before you export. On slow computers, some textures can be missing.
- The export has no tangents. Viewers calculate them from the normal map.
- If the panel does not show, reload the page.

## Report a problem

If a model does not export correctly, [open an issue](../../issues/new/choose) and use the bug report form. The form asks for the model link, your settings, the steps and the console log. Without these data, the problem cannot be found.

## For developers

- [`docs/NOTES.md`](docs/NOTES.md) has the technical notes: how the viewer stores data, the decisions in the exporter and the test history.
- [`tools/`](tools/) has read-only console probes. Paste a probe in the console of the viewer frame to examine a model.

## Credits

- Original script injection: Risk
- Skeleton, animation and export work: anotherRandomPersonlol

## Disclaimer

This tool is for **personal archival and educational use**. You are responsible for obeying:

- the copyright of the model creators,
- the [Sketchfab Terms of Service](https://sketchfab.com/terms),
- the laws of your country about digital content.

The author does not support the sharing of copyrighted content.

## License

MIT. See [LICENSE](LICENSE).
