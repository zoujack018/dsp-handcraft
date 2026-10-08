# 第三方文件来源

本目录与 `src/codec/`、`icons/` 下的部分文件不是本项目原创，来源和许可如下。本项目整体以 GPL-3.0 发布（见根目录 `LICENSE`）。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `data/Vanilla.json`、`data/Buildings.json` | [antian369/dsp-calc](https://github.com/antian369/dsp-calc)（数据源自 [DSPCalculator/dsp-calc](https://github.com/DSPCalculator/dsp-calc)） | 木兰宽松许可证 第2版，见 `LICENSE-dsp-calc-MulanPSL2.txt` |
| `src/codec/*`（蓝图字符串编解码） | antian369/dsp-calc 的 `src/blueprint/`，其 README 注明改自 [cying314/edit-dspblue-print](https://github.com/cying314/edit-dspblue-print) | 上游 cying314 仓库为 GPL-2.0 |
| `icons/*.png`（物品图标）、`favicon.ico`（网站图标） | [122474363/DSQ](https://github.com/122474363/DSQ)（戴森球计划量产量化计算器）的 `Scripts/data.json`、`favicon.ico` 导出；物品图标原图是游戏《戴森球计划》的美术素材 | DSQ 仓库为 GPL-3.0；游戏素材版权归原作者 |

本项目对这些文件的修改：

- `Vanilla.json` 去掉了 UTF-8 BOM，方便以 JSON 模块直接导入。
- `src/codec/` 的相对导入补全了 `.js` 扩展名，`pako` 改为命名空间导入，使其能在 Node 和 Vite 下同时运行。删除了与旧混带布局绑定的 `builder.js`、`constant.js` 和没用到的 `enumParamOpt.js`。
