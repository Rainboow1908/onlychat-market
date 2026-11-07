# Minimap（Rust → wasm32）

`plugins/minimap` 的 Rust/wasm 小地图，渲染模型对齐 Xaero's Minimap 的核心特征：

- 玩家永远落在**同一个整数设备像素中心**，缩放前后不漂移；
- **像素格**：源图 1 像素 = 1 方块；前端按格矢量绘制（每格一个抗锯齿四边形），
  放大后格子内部保持纯色，只用 canvas 抗锯齿得到 1–2px 的边缘过渡；
- **常加载**（`preloadMap`，默认开启）：插件始终输出 `renderRange` 范围的整张地图，
  前端只按 `sourceX/Y/W/H` 裁剪可视部分；缩小/滚轮不会重建图像，边缘始终是真实地形；
- **方块材质**（`blockDetail > 1`）：逐格从 atlas 绘制 16×16 上方面纹理（最近邻），
  即使格子小于 2 设备像素也不回退平均色；超大可见格数时降级为 tile 众数 texel
  位图（仍是材质取样）；
- **方块描边**（`cellBorder`，默认关闭）：默认用 0.5 设备像素重叠消除格子缝隙，
  打开时逐格画 1px 深色描边；
- **连续缩放**（无档位）：滚轮和 slider 都产生连续的 block step；滚轮立即发布变换帧，
  停止后重建一次源图（常加载开启时通常不重建）；
- 玩家/其他玩家显示为**皮肤头像**（固定 16px、保持正立），查不到皮肤时回退为首字母圆形；
- 右键头像/地图空白弹出插件菜单，发送 `/tp` 命令；
- 朝向旋转（`orientation=player`）只旋转图像采样，头像和文字保持正立。

## 构建

```powershell
cd onlychat-next/plugins/minimap
cargo build --release --target wasm32-unknown-unknown
copy ..\..\..\.build\target\wasm32-unknown-unknown\release\minimap_plugin.wasm plugin.wasm
```

`plugin.toml` 的 `entry = "plugin.wasm"`、`api = 1`。构建产物也可用
`cargo run -p onlychat-plugin-runtime --example load_plugin -- plugins/minimap/plugin.wasm`
（在 `onlychat-next` 下）做无 daemon 加载检查。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/lib.rs` | 状态机、`init/on_tick/on_event/on_config/serialize_state/restore_state`、发布帧 |
| `src/config.rs` | 设置解析（类型错误时回退默认值）、主题配色 |
| `src/view.rs` | 连续 block step、相机、世界 ↔ 屏幕变换（含右键反投影） |
| `src/resources.rs` | `assets_ensure` 清单解析、方块颜色/贴图/topVisible/tint、群系染色、实体分类 |
| `src/world.rs` | `WorldFrame` JSON 快速解析（十进制数组或 base64 u16/i16 数组）、数组补齐、内容指纹 |
| `src/image.rs` | 一像素一方块的方块图、群系染色、高度阴影、材质变体 |
| `src/shapes.rs` | 网格、玩家头像、实体圆点、坐标行、方位字母、悬浮标签、右键菜单 |
| `src/frame.rs` | `ui_publish` JSON 序列化 |
| `examples/smoke.rs` | 宿主侧 wasm 冒烟测试（交互、帧校验、缩放 PNG、fuel/耗时） |

## 渲染模型

### 1. 连续缩放

`plugin.toml` 的 `zoom` 是连续 slider（0.5–2.5，步长 0.01）。插件把它映射成连续的
CSS 像素/格 `k`（`view::block_step`），曲线仍经过旧档位的六个点：

| `zoom` | 0.5 | 0.9 | 1.3 | 1.7 | 2.1 | 2.5 |
| --- | --- | --- | --- | --- | --- | --- |
| CSS px/格 | 1 | 2 | 3 | 4 | 6 | 8 |

中间任意值（例如 1.07 → 2.425 px/格）都有自己的 block step，不存在档位量化。
滚轮用 `zoom *= exp(-deltaY * 0.0015)` 连续缩放；停止 450ms 后写回精确的连续值，
`on_config` 用 5 秒 echo 抑制避免回环。

`renderRange`（默认 128，范围 32–256，单位格）只决定 daemon 的采样窗口
（`2 * range + 1`，最大 513）和可访问的世界数据；它**不再**决定图像分辨率。

### 2. 像素格：1 图像像素 = 1 方块

`preloadMap = true`（默认）时插件始终输出整个采样窗口：

```text
columns = min(2*renderRange + 1, 385, frame 边长)
first   = floor(camera - (columns - 1) / 2)
```

`385²` 是常加载图像的上限：`renderRange = 256` 的 513² 窗口过大，只保留中心
385×385；最小 zoom 也会按这个上限重新 clamp，因此可见面板仍由真实地形覆盖。
`preloadMap = false` 时退回旧的“只画可视范围”：

```text
北向上:   columns = ceil(panel / k) + 1
跟随玩家: columns = ceil(panel * √2 / k) + 1
最终:     columns = min(columns, frame 边长, renderRange*2+1, 513)
```

前端：

```text
deviceCenter = floor(canvasSize / 2)          // 整数设备像素
deviceScale  = scale * dpr                    // 连续值，例如 6 × 1.4 = 8.4
transform    = translate(deviceCenter) + rotate(rotation) + scale(deviceScale)
```

- 只遍历 `sourceX/sourceY/sourceW/sourceH` 指定的可视子矩形，缩放/平移只改变这个
  source rect 与目标矩形，不重画整张常加载图。
- 每个可见格子用 `fillRect(x, y, 1, 1)` 绘制（1 单位 = 1 格），相邻同色格先合并成
  一条 run；格子内部纯色，边界由 canvas 抗锯齿产生 1–2px 过渡。
- 默认（`cellBorder = false`）每个 run 在设备空间多画 0.5px 与相邻格重叠，消除
  格子之间的 AA 缝；`cellBorder = true` 时再逐格画 1px 深色描边。
- `orientation=player` 时整张格子网格绕同一个整数设备中心旋转，坐标保持连续值。
- 平均色逐格路径上限 **8000** 个可见格；纹理/描边路径带滞回：进入位图
  **>51000** 格，回到逐格 **<36000** 格；另有 run 保险 **>12000 / <6000**。
  超过上限或 run 数时退回“1 像素/方块 + 最近邻裁剪缩放”，颜色取该 tile 的
  **众数 texel × tint × shade**（不是 palette 平均色）。阈值常量在
  `pluginPanelRender.ts`。

由于 `deviceScale` 是连续的，源图每个格子在设备像素网格上的落点会位于非整数位置。
逐格绘制只在边界产生抗锯齿，内部不会被重采样，因此放大 6–8 倍也不会糊。

### 2.1 最小 zoom

`orientation=player` 时面板需要 `panel * √2 / k` 个方块；daemon 窗口只有
`2 * renderRange + 1`。插件用 `view::min_zoom_with_cap(panel, rotated, renderRange,
preload ? Some(385) : None)` 计算最小允许 zoom，并在 `current_zoom` 与滚轮里同时 clamp：

```text
window = min(2*renderRange + 1, preload ? 385 : ∞)
min_k  = max(panel * (rotated ? √2 : 1) / (window - 2), 1)
zoom   = zoom_for_block_step(min_k)
```

这样缩到最小时窗口仍能覆盖整个旋转面板，不会露出黑角；`renderRange = 256` 时以
385 的上限为准。发布前还会用**实际图像窗口**（`view.columns`，含 daemon 当前帧
尺寸）再 clamp 一次：`min_block_step(panel, rotated, columns)`，因此即使设置/滑杆
仍保存更小的 zoom，实际帧也不会小于可行 scale，source rect 始终在图像内。若 daemon
数据窗口仍然不足（旧版本/边缘区块还没加载），前端背景取地图边缘的平均色
（`edgeAverage`）；如果图像边框本身是透明，改用实际不透明区域外圈的平均色，而不是
深色面板背景。

### 3. 玩家居中：唯一的设备像素中心

图像中心、shapes、自己头像全部使用同一个整数中心：

```text
canvasWidth = round(frame.width * dpr)
center      = floor(canvasWidth / 2)                 // deviceCenter()
offsetX     = center - frame.width / 2 * dpr         // CSS → device 平移
```

- 插件以 `camera` 为图像中心采样，因此图像中心就是玩家；
- 前端把图像居中绘制（旋转时绕 `center`）；
- shapes 用 `setTransform(dpr, 0, 0, dpr, offsetX, offsetY)`，CSS 的 `panel/2`
  正好落在 `center`；
- 自己标记无 pan 时是 `panel/2`，与图像中心是同一个像素。

中心只由 canvas 尺寸决定，和缩放/范围无关。

### 4. 滚轮：即时变换帧 + 空闲重建

滚轮事件不会触发图像重采样。插件立即发布一个 **transform frame**：

```text
imageTransform.scale      = 目标 k
imageTransform.imageScale = 缓存位图实际的 k
imageTransform.imageId    = 位图内容 id（稳定哈希）
image.pixels / shades     = ""（省略大图）
```

前端把缓存的格子网格按目标 `scale * dpr` 绕中心即时逐格重绘。格子网格按 `imageId`
缓存，图像 id 未变时不会重新传输/解码位图；前端 LRU 最多保留 4 张。

- 变换帧按约 60Hz 合并（最小间隔 15ms）；同一时刻的多个滚轮只发最后一帧。
- 停止滚动约 250ms 后（阈值 200ms + 50ms tick），插件按目标 `k` 重建一次像素格源图，
  发布带新 `imageId` 的完整帧；实测 300–400ms 内到达。`preloadMap = true` 时图像
  窗口与 zoom 无关，`ImageKey` 通常不变，滚轮停止后不会重建。
- 450ms 后只写回 zoom 设置，复用同一 `imageId`，不再传输图像。
- 图像 id 由 `ImageKey` 的稳定哈希生成（包含相机/缩放/DPR/地形/资源版本），插件或
  面板重启后同内容可复用前端缓存。

### 5. 材质与描边

- `blockDetail = 1`：每个方块输出平均色 + 高度阴影。
- `blockDetail > 1`：额外输出 `texture`（`atlas`、`detail`、以 1-based palette index
  为键的 `tiles` / `tints`）。前端把每个 atlas tile 预乘群系染色和该格的
  **shade**，按“一 tile = 一 block”的重复 pattern 绘制，`imageSmoothingEnabled =
  false`（最近邻）。相邻同 tile/tint/shade 的格子在行内合并成 pattern run。
- 不论格子多大（包括 k=1、1 设备像素），`blockDetail > 1` 都只使用材质颜色，
  不会把 palette 平均色当作格子颜色。格子小于 1 texel 时由最近邻采样选中某个
  texel。
- 纹理逐格路径带**滞回**：当前逐格时超过 **51000** 格或 **12000 run** 才进位图；
  当前位图时低于 **36000** 格且低于 **6000 run** 才回逐格。这样同一 zoom 下来回
  1–2 格的 source rect 不会在纹理/位图之间闪烁。
- 降级为 1 像素/方块位图时，颜色取该 tile 的**众数 texel**（出现次数最多的不透明
  texel）× tint × shade，仍不是平均值。本实现选众数 texel（比中心 texel 更稳定，
  中心可能透明）。
- atlas 短暂变为未就绪时，渲染器沿用**上一帧同路径的 atlas**；如果连上一帧都没有，
  直接跳过该帧，不把画布清成灰色/平均色。取不到 tile 的 palette 项也跳过该格，
  不使用 palette 平均色。
- 每个格子的 shade 同时叠加在基色和纹理上；纹理不会取消高度明暗。无 tile 的
  palette 项（未知方块）才使用 palette 颜色。
- `cellBorder = false`（默认）：run 在设备空间向右侧/下方多画 0.5px 与下一格重叠，
  消除 canvas 抗锯齿造成的 1px 缝隙。`cellBorder = true`：逐格 `strokeRect`，
  `lineWidth = 1 / deviceScale`，颜色 `rgba(0,0,0,0.42)`；仅在 `deviceScale >= 2`
  且走逐格路径时生效。

### 6. 其它保留功能

- 群系染色、高度起伏阴影、透明方块 ground 底层（`texture.unders`）。
- `orientation=player`：整个格子网格绕中心连续旋转；玩家头像、实体点、网格、
  N/E/S/W 和文字保持正立。头像固定 16px，不随缩放或旋转改变大小。
- **皮肤头像**：帧里输出 `kind:"avatar"`（name/uuid/skinUrl/x/y/yaw/self）。前端用
  uuid/name 在 tab list 里查皮肤；自己没有 `skinUrl` 时查账号列表；都查不到时画
  主题色圆形 + 名字首字母，绝不画黑块。
- **右键菜单**：头像命中 → “传送到玩家” `/tp <name>`；空白命中 → “传送到此处”
  `/tp x y z`。插件以 `kind:"menu"` shape 发布（含 `at`、屏幕坐标、世界坐标、
  `compact: true` 和带 `label/detail/command` 的 items）。`detail` 由插件生成：
  玩家名或 `x y z`。前端 `ContextMenu` 只根据通用 `compact` 字段缩小尺寸，不包含
  任何小地图专属判断；compact 菜单项高度 28px、上下内边距 2px，整体宽度比之前窄
  8px（`min-width: 140px`，item 水平内边距 4px），detail 字号 9px。右键不会触发
  拖动/平移。
- 鼠标中键拖动平移（前端 `PluginPanel.svelte` 已发送 `down/drag/up`）、边缘 resize。
- 坐标行、层数、悬浮名称/坐标、玩家/实体过滤、主题、透明度、形状裁切。
- 会话切换重置 pan/zoom；状态快照保存 pan、连续 zoom、size。

## 已知差异 / 未做到的部分

- 世界窗口最大 513×513（`renderRange = 256`）。常加载图像上限为 385×385，
  `renderRange = 256` 时只保留中心窗口，最小 zoom 也按 385 计算；更远不会伪造地形。
- `renderRange` 增大只增加 daemon 世界窗口的数据量和常加载图尺寸；图像构建成本按
  `min(2*range+1, 385)²` 增长。超大世界窗口的 `world_query` 传输/解析仍按范围增长，
  这是世界数据路径而不是图像渲染路径。
- daemon 的 typed image schema 现在允许到 1024；`imageTransform.imageWidth/imageHeight`
  仍作为精度/兼容字段保留。
- 滚轮不再做 150ms 整图动画：即时反馈用缓存的格子网格按新 `deviceScale` 逐格重绘，
  停止后才重建一张新的源图。
- 右键 TP 的 Y 取当前图层在命中列的地形高度 + 1（Xaero surface view / cave layer
  的行为）；命中点在世界快照之外时回退为当前玩家 Y。
- 渲染采用逐格矢量绘制：格子内部纯色，边界 1–2px 抗锯齿；不再对整张位图做插值。
  平均色路径超过 8000 格、纹理/描边路径超过 51000 格（回到逐格需 <36000）时退回
  最近邻位图缩放。
- `blockDetail = 1` 只有平均色 + 阴影；`> 1` 使用 atlas 纹理，无论格子大小都不会
  退回平均色。降级位图的颜色是 tile 众数 texel × tint × shade，不是 tile 平均色。
- `renderRange = 256` 的常加载窗口被限制为 385²；最外圈 128 格不会进入常加载图。
- 拖动平移仍依赖中键；左键保留给移动面板窗口。

## 帧格式

```json
{
  "sessionId": "ses-...",
  "width": 220, "height": 220,
  "corner": "top-right", "opacity": 0.92,
  "background": "#0b1017", "clip": "rounded",
  "image": {
    "width": 257, "height": 257,
    "palette": ["#rrggbbaa"],
    "pixelBytes": 2,
    "pixels": "<base64 u16 LE, 0-based palette index>",
    "shades": "<base64 u8, 128 = unchanged>",
    "scale": 3,
    "originX": -113.0,
    "originY": -113.0
  },
  "rotation": 2.356,
  "texture": { "atlas": "...", "detail": 16, "tiles": { "3": { "x": 0, "y": 0, "w": 16, "h": 16 } }, "tints": { "7": "#91bd59" }, "unders": {} },
  "shapes": [
    {
      "kind": "imageTransform", "scale": 3,
      "originX": -113.0, "originY": -113.0,
      "firstX": -128, "firstZ": -128,
      "sourceX": 56, "sourceY": 56, "sourceW": 145, "sourceH": 145,
      "cellBorder": false,
      "cameraX": -0.33, "cameraZ": -0.33
    }
  ],
  "settings": { "zoom": 1.3 }
}
```

- `imageTransform` shape：`mode:"pixel"`、`drawMode:"cells"`（前端按格矢量绘制；
  缺省则按位图缩放）、`scale` = 目标 **CSS 像素/格**、`imageScale` = 缓存位图实际
  采样比例、`imageId` = 稳定内容 id、`cameraX/cameraZ` = 连续相机位置、
  `firstX/firstZ` = 图像左上角方块、`imageWidth/imageHeight` = 图像方块数、
  `sourceX/sourceY/sourceW/sourceH` = 可视裁剪矩形（图像格坐标）、
  `cellBorder` = 是否逐格描边。`image.pixels/shades` 为 `""` 时表示复用前端同
  `imageId` 的缓存网格；`texture.tiles/tints` 以 1-based palette index 为键
  （前端取 `paletteIndex + 1`）。
- `kind:"avatar"`：玩家/自己头像，固定 `size:16`，带 `name/uuid/skinUrl/yaw/dirX/dirY/self`。
- `kind:"menu"`：只随右键那一次发布出现；`at` 用于前端去重，`compact:true`、
  `items[].detail` 和 `items[].command` 由插件生成。
- `rotation`：仅 `orientation=player` 出现，图像采样绕设备像素中心反向旋转。
- `settings` 只在需要写回时出现（滚轮停止 450ms、resizeend）。

## 测试与验证

```powershell
# 单元测试：像素格尺寸、缩放无漂移、旋转不变、重建耗时
cargo test --manifest-path plugins/minimap/Cargo.toml

# wasm 冒烟 + 缩放 PNG（输出到仓库 .tmp/minimap-refactor）
cargo build --release --target wasm32-unknown-unknown
cargo run --example smoke --release -- <repo>\.build\target\wasm32-unknown-unknown\release\minimap_plugin.wasm
```

冒烟测试会打印每个 zoom 的 `k`、图像尺寸、地标屏幕坐标和单帧耗时，并输出
`minimap-zoom-1px.png` … `minimap-zoom-8px.png`（历史六个采样点）。环境变量：
`MINIMAP_FUEL` 覆盖 fuel 上限、`MINIMAP_B64=1` 用 base64 世界数组、
`MINIMAP_SCENARIO=light|heavy|parseonly|header|tiny`、`MINIMAP_EVIDENCE_DIR` 指定
PNG 目录。

### 测试覆盖

| 需求 | 测试 |
| --- | --- |
| 缩放连续、无档位 | `view::tests::zoom_is_continuous_not_quantized`、`tests::wheel_zooms_continuously` |
| 任意两个 zoom 之间中心不变 | `view::tests::centre_is_pixel_identical_for_every_zoom`、`view::tests::changing_zoom_never_moves_the_centre_landmarks`、`shapes::tests::self_marker_is_exactly_centred_at_every_zoom` |
| 方块 step 连续 | `view::tests::every_block_keeps_the_continuous_step` |
| 图像尺寸 = 可见方块数 | `view::tests::image_size_is_the_visible_block_count`、`image::tests::image_size_is_the_visible_block_count` |
| 旋转不改变边长/面积 | `view::tests::rotation_preserves_block_edge_length_and_area` |
| 头像数据/正立/回退 | `shapes::tests::player_markers_are_avatars_with_identity_but_no_rotation`、`shapes::tests::self_avatar_is_upright_and_heading_is_only_a_tick` |
| 右键菜单两条路径 | `shapes::tests::right_clicking_a_player_teleports_by_name`、`shapes::tests::right_clicking_empty_map_uses_terrain_height`、`tests::right_click_queues_one_menu_shape` |
| 最小 zoom 覆盖旋转窗口 | `view::tests::minimum_zoom_covers_the_rotated_window` |
| 常加载整窗口 + 可视 source rect | `view::tests::preload_renders_the_whole_window_and_sources_the_visible_crop`、`image::tests::preload_builds_the_whole_window` |
| 385² 上限限制最小 zoom | `view::tests::preload_cap_limits_min_zoom_to_the_385_window` |
| 一像素一方块、无混合色 | `image::tests::one_image_pixel_is_the_block_at_first_plus_index`、`image::tests::pixels_are_flat_and_heading_independent` |
| 纹理 palette 引用 | `image::tests::block_detail_emits_texture_references` |
| 前端逐格矢量绘制 | Chrome 实际渲染器：k=8 时格内仅 1 种颜色，非整数落点边界只有 1px 抗锯齿；同 zoom 重绘 0 字节差异 |
| 纹理始终可见（无平均色回退） | Chrome：k=4 格内方差 **6094**；k=1 所有采样颜色都在 tile texel 集合内、平均值 `167,91,63` 不出现；shade 96/128 亮度比 **0.75** |
| 大图降级仍取材质 | Chrome：150k 格降级位图中心色 `220,40,40`（tile 众数 texel），不是平均色 |
| 纹理 run 保险 | Chrome：24,964 格 + 256 档随机 shade 触发 12000-run 保险，改走众数 texel 位图，首帧 **2.0 ms** |
| 阈值滞回/不闪 | Chrome：66k 位图 → 32.5k 帧序列 24 帧，0 灰帧、0 灰像素，纹理色数始终 22 |
| atlas 短暂未就绪 | Chrome：20 帧交替 atlas/null，0 灰帧，中心始终 texel 色 |
| scale 1.0999 材质色 | Chrome：85,849 格降级位图中心 `220,40,40`（tile 众数 texel），非平均 `167,91,63` |
| 实际窗口 clamp | `view::tests::min_block_step_fits_the_actual_window` |
| 描边与缝隙 | Chrome：`cellBorder=false` 行扫描 0 个深色像素；`true` 时每个竖边 1–2px 深色线；无缝测试 0 个背景像素/0 个透明像素 |
| 常加载边缘 | Chrome 合成双色地图：常加载 64² 四角 2 种地形色；32² 短窗口四角为单一平均色 |
| 世界数组缓存 | `world::tests::cache_reuses_arrays_when_only_player_and_time_change` |
| base64 世界数组 + JSON 回退 | `world::tests::parses_base64_u16_and_i16_arrays`、`world::tests::base64_frame_pads_a_large_window_to_width_times_height`、`world::tests::parses_entity_with_null_name`（JSON 数组） |
| 重建性能 ≤50ms | `image::tests::image_rebuild_fits_the_frame_budget`、`image::tests::preload_257_rebuild_is_cheap` |
| 逐格绘制性能 | Chrome：1,600 格 **0.31 ms**，7,921 格棋盘 **1.67 ms**；>8000 格走最近邻位图兜底 |
| 缩到最小无黑角 | Chrome：320/250 面板、旋转、`min_zoom` 下四角 alpha=255 且为地图颜色 |

## 性能参考

wasm 侧（wasmi，像素格图像，世界窗口 129–513，本机 release）：

| 场景 | 耗时 |
| --- | --- |
| 常加载 257² 重建 | **6.05 ms**（native，含纹理 palette） |
| 常加载 385² 完整帧首次绘制 | Chrome **15.7 ms**（含 atob/解码/网格/背景）；缓存后 **1.1 ms** |
| 常加载 257² 完整帧首次绘制 | Chrome **5–8 ms**（JIT 冷启动首帧 11 ms）；缓存后中位数 **1.0–1.1 ms** |
| 滚轮变换帧（常加载，22 帧） | 每帧 **1.6 KB**，`imageId` 不变，source 87→257，**不重建** |
| 停止滚动后的完整重建（常加载） | 通常仅世界内容变化才重建；257²/385² 帧 **260–285 KB / 600 KB** |
| 前端纹理逐格绘制（117²，k=4，真实 atlas） | 首次 **12 ms**（含建网格），之后约 **1–2 ms** |
| 纹理逐格 24,964 格（k=1，地形式 shade） | 首次 **7.0 ms**，重复绘制中位数 **1.4 ms**，最大 1.9 ms |
| 纹理逐格 40,000 格 | 首次 **5.6 ms**，重复绘制中位数 **1.7 ms**，最大 1.9 ms |
| 纹理逐格 50,176 格 | 首次 **4.1 ms**，重复绘制中位数 **1.1 ms**，最大 1.3 ms |
| 同上 24,964 格但 256 档随机 shade（run 保险触发） | 降级位图：首次 **2.0 ms**，重复绘制中位数 **0.1 ms** |
| 纹理降级位图 150,544 格 | 首次 **13.6 ms**，重复绘制中位数 **0.4 ms** |
| 前端变换帧逐格绘制（43–60 格边长） | 中位数 **0.2–0.4 ms**（1,849–3,600 格，合并同色 run） |
| 7,921 格棋盘最坏情况 | **1.67 ms**（无 run 可合并），仍远低于 16ms |
| 位图 LRU | 6 个 imageId 后仍为 **4** 张 |
