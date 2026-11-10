# jupyterlab-graffiti

[中文说明](README.zh-CN.md)

Record a Jupyter notebook and play it back in place. A recording can include cell edits, execution, scrolling, drawings, and microphone narration.

This is a JupyterLab 3 port of [Jupyter Graffiti](https://github.com/willkessler/jupytergraffiti). Recordings use the same `jupytergraffiti_data` directory as the classic notebook extension. JupyterLab 4 is not supported.

The classic sticker catalog is not included.

## Requirements

- Python 3.8 or newer
- JupyterLab 3.6 or newer, and older than 4

The repository already contains the built frontend. Installing does not require Node.js.

## Install

```bash
python -m pip install "git+https://github.com/simonclouds/jupyterlab-graffiti.git"
```

On JupyterHub, install into the user environment, then restart that user's notebook server:

```bash
python -m pip install --user "git+https://github.com/simonclouds/jupyterlab-graffiti.git"
```

From a local clone:

```bash
python -m pip install .
```

Restart JupyterLab after installing. Open a notebook and use **Activate Graffiti** on the toolbar.

To replace an older copy of this extension:

```bash
python -m pip install --force-reinstall --no-deps "git+https://github.com/simonclouds/jupyterlab-graffiti.git"
```

Restart JupyterLab again so it loads the new frontend files.

## Use

1. Click **Activate Graffiti** and accept the dialog. The floating panel opens. A notebook that was activated before shows **Show Graffiti Editor** and **Hide Graffiti Editor** instead.
2. Click **Record**, then click in the notebook. Recording starts on that click.
3. Edit cells, run them, scroll, and draw. The panel names the microphone it is using.
4. Hold the Option key to stop. On other keyboards that key is Alt. A green marker appears beside the cell.
5. Click the marker to play. Press Esc to leave playback and restore the cell text from the moment playback started.

A short press of Option during recording marks a skip. During playback the panel can pause, scrub, change speed, mute, and jump 5 seconds.

**Rerecord**, **Cleanup Takes**, and **Remove Graffiti** apply to the movie on the active cell.

## Microphone

Browsers only provide a microphone on a secure page: `https://`, or `http://localhost`. On any other `http://` address, Chrome locks the site's microphone permission and this extension cannot record narration.

For a private JupyterLab that is served over `http://`, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, set the flag to **Enabled**, and enter the exact origin, including the scheme and port. For example, `http://192.168.1.10:8888`. Relaunch Chrome, reload JupyterLab, and allow the microphone when asked.

Also allow Chrome in the operating system's microphone privacy settings.

Chrome sometimes prefers a virtual input, such as BlackHole or a meeting loopback, over the computer's microphone. When the selected device looks virtual, this extension switches to a built-in microphone. After recording starts, the panel shows the device name, for example `Recording from MacBook Pro Microphone (Built-in)`.

## Recordings on disk

The notebook server writes recordings under its working directory:

```text
jupytergraffiti_data/notebooks/<notebook-id>/authors/<author-id>/
```

`manifest.json` and each take's `history.txt` are stored with the classic LZ-string compression. `audio.txt` is the narration as base64 WebM. The layout matches classic Jupyter Graffiti.

## Python API

Call this from a notebook in the same JupyterLab session. The editor must already be loaded for that notebook.

```python
import jupyterlab_graffiti

jupyterlab_graffiti.play_recording("recording-or-take-id")
jupyterlab_graffiti.play_recording_with_prompt("recording-or-take-id", "optional prompt")
jupyterlab_graffiti.stop_playback()
jupyterlab_graffiti.set_access_level("view")  # "view" disables recording
jupyterlab_graffiti.transfer_graffiti()
jupyterlab_graffiti.package_graffiti()
```

`package_graffiti()` writes `graffiti_package.tar.gz` from the `jupytergraffiti_data` directory.

## Development

Node.js is required only to rebuild the frontend.

```bash
npm install
npm run test:unit
npm run build
npm run build:labextension
python -m pip install --force-reinstall --no-deps .
```

`npm run build:labextension` uses the `jupyter` command on `PATH`, and that JupyterLab must be 3.6. After a frontend change, include the updated files in `jupyterlab_graffiti/labextension/` so other people can still install without Node.js.

Interface tests use [Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata) and Playwright against JupyterLab at `http://127.0.0.1:8888`:

```bash
cd ui-tests
npm install
npx playwright install chrome-for-testing
npx playwright test
```

## License

[BSD 3-Clause](LICENSE).

## Acknowledgements

The panel, recording flow, on-disk format, and kernel API follow [Jupyter Graffiti](https://github.com/willkessler/jupytergraffiti) by Will Kessler. This repository is a separate implementation for JupyterLab 3.
