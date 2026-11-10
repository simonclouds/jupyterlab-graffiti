# jupyterlab-graffiti

JupyterLab 3.6 上的 Jupyter Graffiti。可以在笔记本里录制单元格编辑、执行、滚动、画笔和旁白，并在原位回放。录制结果沿用经典 Jupyter Graffiti 的 `jupytergraffiti_data` 目录。

适用于 JupyterLab `>=3.6,<4`，Python `>=3.8`。仓库里已经带有构建好的前端，安装时不需要 Node.js。

## 安装

```bash
python3 -m pip install .
```

JupyterHub 上建议装到用户目录：

```bash
python3 -m pip install --user /path/to/jupyterlab-graffiti
```

装完后重启 JupyterLab。打开笔记本，工具栏第一个按钮是 **Activate Graffiti**。确认之后会出现浮动的 graffiti 面板。

已经装过时，用下面的命令换成这一份：

```bash
python3 -m pip install --force-reinstall --no-deps .
```

然后同样重启 JupyterLab。

## 使用

1. 点击 **Activate Graffiti**，确认对话框。
2. 点击 **Record**，再在笔记本里点一下，开始录制。
3. 按住 Option（Alt）键结束录制。单元格左侧会出现绿色标记。
4. 点击标记即可回放。

录音保存在笔记本服务器上的 `jupytergraffiti_data/`。

## 麦克风

浏览器只允许在安全页面使用麦克风。用 `https://` 打开 JupyterLab，或者在 Chrome 中打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，启用后填入实验页的完整地址（包含 `http://` 和端口），然后重新启动浏览器。

如果电脑上有 BlackHole 这类虚拟声卡，Chrome 可能会优先录到它们。本插件会改用内置麦克风。录制开始后面板上会写明当前使用的设备，例如 `Recording from MacBook Pro麦克风`。

## 开发

修改 `src/` 之后需要重新构建前端：

```bash
npm install
npm run build
npm run build:labextension
python3 -m pip install --force-reinstall --no-deps .
```

`npm run build:labextension` 需要当前环境里已有 JupyterLab 3.6。

单元测试：

```bash
npm run test:unit
```

界面测试在 `ui-tests/`，需要本机 JupyterLab 和 Playwright。
