# Contributing

Thank you for helping to make Sketchfab Ripper better. This page tells you how to report a problem, how to ask a question and how to send a code change.

## Ask a question

Use [Discussions](../../discussions) for questions and ideas. Use Issues only for problems with an export.

## Report a problem

Before you report:

1. Update the script to the latest version. Click the Tampermonkey icon, then click **Check for userscript updates**.
2. Reload the model page and export again.
3. Keep the Sketchfab tab visible while you record. A hidden tab loses frames.
4. Look at the [open issues](../../issues). If the same model or the same problem is there, add a comment to that issue.

Then [open an issue](../../issues/new/choose) with the bug report form. The form asks for these data:

- The link to the model on Sketchfab. The model must still be visible on Sketchfab.
- The script version and your browser.
- The settings that you changed.
- The steps that cause the problem.
- What you expected and what you got.
- Where you saw the problem: the glTF viewer, Blender, or both.
- The full console log. Press **F12**, open **Console**, type `[Ripper]` in the filter box, then copy all lines.

Without the model link and the log, the problem usually cannot be found.

Do not attach exported files, textures or screenshots of models that you do not have the rights to share. The link to the model page is enough.

## Send a code change

1. Fork the repository and make a branch from `main`.
2. Make the change in `src/Sketchfab-ripper.user.js`.
3. Obey the code rules below.
4. Export at least one model that your change affects, and one model that it does not affect. Check both in the [glTF viewer](https://gltf-viewer.donmccurdy.com/) and with the [glTF validator](https://github.khronos.org/glTF-Validator/).
5. Open a pull request. Tell which models you tested, and paste the `[Ripper]` log lines that show the change.

### Code rules

- Use ES5 syntax only: `var` and `function`. Do not use arrow functions, `let`, `const`, template strings, classes or destructuring. The whole script uses this style.
- Write one `log()`, `warn()` or `err()` line for each important action, with the `[Ripper]` prefix that these functions add. A bug report is only as good as the log.
- Put new parts of the script between `// ====` section lines, as the other parts are.
- Run `node --check src/Sketchfab-ripper.user.js` before you commit.
- Increase `@version` in the script header and add a line to [`CHANGELOG.md`](CHANGELOG.md).
- Put research notes and test results in [`docs/NOTES.md`](docs/NOTES.md).

### Probes

The [`tools/`](tools/) folder has read-only console probes. A probe shows how the viewer stores a part of the model, for example textures, materials or animation targets. To use a probe, open the console, change the context list (it shows **top**) to the viewer frame, and paste the probe.

## License

When you send a change, you agree that it is published under the [MIT license](LICENSE) of this repository.
