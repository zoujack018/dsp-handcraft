# 第三方文件来源

本目录与 `src/codec/`、`icons/`、`web/calc/`（打包后在 `calc/`）下的部分文件不是本项目原创，来源和许可如下。本项目整体以 GPL-3.0 发布（见根目录 `LICENSE`）。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `data/Vanilla.json`、`data/Buildings.json` | [antian369/dsp-calc](https://github.com/antian369/dsp-calc)（数据源自 [DSPCalculator/dsp-calc](https://github.com/DSPCalculator/dsp-calc)） | 木兰宽松许可证 第2版，见 `LICENSE-dsp-calc-MulanPSL2.txt` |
| `src/codec/*`（蓝图字符串编解码） | antian369/dsp-calc 的 `src/blueprint/`，其 README 注明改自 [cying314/edit-dspblue-print](https://github.com/cying314/edit-dspblue-print) | 上游 cying314 仓库为 GPL-2.0 |
| `src/gamedata.js` 的 `STACK_SIZE`、`FLUIDS`（物品堆叠上限、哪些是液体） | [dsp2b/dsp2b](https://github.com/dsp2b/dsp2b) 的 `data/itemProtoSet.json`（原版游戏物品表导出） | GPL-3.0 |
| `web/calc/dsq-data.js`（打包后 `calc/dsq-data.js`，量产计算器的配方数据）；量产计算器 `web/calc/` 的界面照它重做，图集 `calc-icons.*` 由它的 `Scripts/data.json` 拼成（`web/calc/make-icons.py`） | [122474363/DSQ](https://github.com/122474363/DSQ)（戴森球计划量产量化计算器）的 `Scripts/data.js`，原样抄来不改 | GPL-3.0 |
| `src/beltless/dsq.js`（无带流蓝图生成器）、`src/beltless/ids.js`（物品名对游戏 ID） | 同上 DSQ 的 `Scripts/blueprint.js`、`Scripts/data.js` 末尾的 `GAME_ITEM_IDS`（和 `web/calc/dsq-data.js` 同一份），改成模块：开头引 pako 和 ids.js、末尾导出，代码原样不动 | GPL-3.0 |
| `icons/*.png`（物品图标）、`favicon.ico`（网站图标） | [122474363/DSQ](https://github.com/122474363/DSQ)（戴森球计划量产量化计算器）的 `Scripts/data.json`、`favicon.ico` 导出；物品图标原图是游戏《戴森球计划》的美术素材 | DSQ 仓库为 GPL-3.0；游戏素材版权归原作者 |

本项目对这些文件的修改：

- `Vanilla.json` 去掉了 UTF-8 BOM，方便以 JSON 模块直接导入；加了游戏 0.10.35 的黑雾引力透镜（物品 1211、配方 162，和 ProjectGenesis 的 ProtoID.cs、komonad/dsp-solver 2026/10/14 更新的数据一致），地基的格位跟着游戏挪到 1707。
- `src/codec/` 的相对导入补全了 `.js` 扩展名，`pako` 改为命名空间导入，使其能在 Node 和 Vite 下同时运行。删除了与旧混带布局绑定的 `builder.js`、`constant.js` 和没用到的 `enumParamOpt.js`。
