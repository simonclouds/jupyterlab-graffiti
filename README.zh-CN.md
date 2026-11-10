# jupyterlab-graffiti

[English](README.md)

在 JupyterLab 里录制笔记本，并在原处回放。一次录制可以包含单元格编辑、执行、滚动、画笔和麦克风旁白。

这是 [Jupyter Graffiti](https://github.com/willkessler/jupytergraffiti) 的 JupyterLab 3 移植。录音目录 `jupytergraffiti_data` 与经典 Notebook 插件相同。不支持 JupyterLab 4。

经典版里的贴纸库没有移植。

## 环境

- Python 3.8 及以上
- JupyterLab 3.6 及以上，且低于 4

仓库里已经带有构建好的前端，安装时不需要 Node.js。

## 安装

```bash
python -m pip install "git+https://github.com/simonclouds/jupyterlab-graffiti.git"
```

在 JupyterHub 上，装到用户自己的环境里，然后重启该用户的笔记本服务：

```bash
python -m pip install --user "git+https://github.com/simonclouds/jupyterlab-graffiti.git"
```

从本机克隆安装：

```bash
python -m pip install .
```

安装后重启 JupyterLab。打开笔记本，使用工具栏上的 **Activate Graffiti**。

已经装过旧版本时：

```bash
python -m pip install --force-reinstall --no-deps "git+https://github.com/simonclouds/jupyterlab-graffiti.git"
```

再次重启 JupyterLab，让它加载新的前端文件。

## 使用

1. 点击 **Activate Graffiti** 并确认对话框。浮动面板会打开。已经激活过的笔记本显示的是 **Show Graffiti Editor** 和 **Hide Graffiti Editor**。
2. 点击 **Record**，再在笔记本里点一下。录制从这次点击开始。
3. 编辑单元格、运行、滚动、画线。面板上会写出正在使用的麦克风。
4. 按住 Option 键结束。其他键盘上这个键是 Alt。单元格旁边会出现绿色标记。
5. 点击标记即可回放。按 Esc 退出回放，并把单元格文本恢复到播放开始时的内容。

录制中短按 Option 会记一次跳过。回放时可以暂停、拖动进度、变速、静音，以及前后跳 5 秒。

**Rerecord**、**Cleanup Takes**、**Remove Graffiti** 针对当前单元格上的录像。

## 麦克风

浏览器只在安全页面提供麦克风，也就是 `https://` 或 `http://localhost`。其他 `http://` 地址上，Chrome 会锁住该站点的麦克风权限，这个插件无法录到旁白。

如果 JupyterLab 是用内网 `http://` 打开的，可以打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，设为 **Enabled**，并填入完整来源，包括协议和端口。例如 `http://192.168.1.10:8888`。重新启动 Chrome，刷新 JupyterLab，在询问时允许麦克风。

操作系统的麦克风隐私设置里也要允许 Chrome。

Chrome 有时会优先选用虚拟声卡，例如 BlackHole 或会议软件的回环设备，而不是电脑自带的麦克风。选中的设备看起来像虚拟设备时，这个插件会改用内置麦克风。开始录制后面板会写出设备名，例如 `Recording from MacBook Pro Microphone (Built-in)`。

## 录音文件

笔记本服务会把录音写到它的工作目录下：

```text
jupytergraffiti_data/notebooks/<notebook-id>/authors/<author-id>/
```

`manifest.json` 和每次录像的 `history.txt` 使用经典版的 LZ-string 压缩。`audio.txt` 是 base64 编码的 WebM 旁白。目录布局与经典 Jupyter Graffiti 一致。

## Python API

在同一个 JupyterLab 页面里的笔记本中调用。该笔记本需要已经加载 Graffiti 编辑器。

```python
import jupyterlab_graffiti

jupyterlab_graffiti.play_recording("recording-or-take-id")
jupyterlab_graffiti.play_recording_with_prompt("recording-or-take-id", "optional prompt")
jupyterlab_graffiti.stop_playback()
jupyterlab_graffiti.set_access_level("view")  # "view" 会关闭录制
jupyterlab_graffiti.transfer_graffiti()
jupyterlab_graffiti.package_graffiti()
```

`package_graffiti()` 会把 `jupytergraffiti_data` 打成 `graffiti_package.tar.gz`。

## 开发

只有在改前端时才需要 Node.js。

```bash
npm install
npm run test:unit
npm run build
npm run build:labextension
python -m pip install --force-reinstall --no-deps .
```

`npm run build:labextension` 使用 `PATH` 里的 `jupyter`，并且必须是 JupyterLab 3.6。改完前端后，把 `jupyterlab_graffiti/labextension/` 里更新过的文件一并提交，这样其他人安装时仍然不需要 Node.js。

界面测试使用 [Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata) 和 Playwright，目标是 `http://127.0.0.1:8888` 上的 JupyterLab：

```bash
cd ui-tests
npm install
npx playwright install chrome-for-testing
npx playwright test
```

## 许可证

[BSD 3-Clause](LICENSE)。

## 致谢

面板、录制流程、磁盘格式和内核 API 遵循 Will Kessler 的 [Jupyter Graffiti](https://github.com/willkessler/jupytergraffiti)。本仓库是面向 JupyterLab 3 的独立实现。
