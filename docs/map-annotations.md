# 我的地图：数据标准 v1

本页说明「我的地图」的编辑操作、JSON 工程约定与 KML 支持范围。足迹 CSV 与地图标注独立加载和保存。

## 存储与交换

内部工程使用 JSON，格式标识为 `replaymod.annotations`，当前版本为 1。

### 工程字段

| 字段 | 类型 | 必需 | 含义与约束 |
| --- | --- | --- | --- |
| `format` | string | 是 | 固定为 `replaymod.annotations` |
| `version` | number | 是 | 当前固定为 `1` |
| `name` | string | 是 | 工程名称 |
| `nodes` | array | 是 | 节点数组；数组顺序就是同级节点的显示与导出顺序 |

### 节点字段

| 字段 | 类型 | 必需 | 含义与约束 |
| --- | --- | --- | --- |
| `id` | string | 是 | 节点内唯一且稳定的标识 |
| `parentId` | string \| null | 是 | 父 folder 的 id；根节点为 `null` |
| `kind` | string | 是 | `folder`、`point` 或 `route` |
| `name` | string | 是 | 显示名称 |
| `description` | string | 否 | 有实际内容时保存；空字符串不写入 |
| `visible` | boolean | 是 | 节点自身是否可见 |
| `open` | boolean | 否 | 仅展开的 folder 保存 `true`；其他情况不写入 |
| `coordinates` | array | 条件必需 | point 保存一个坐标，route 保存至少两个坐标；folder 不写入 |
| `color` | string | 条件必需 | point / route 使用的 `#RRGGBB` 颜色；folder 不写入 |

`coordinates` 使用 WGS84 二维坐标 `[经度, 纬度]`。KML 中的第三维海拔和 `altitudeMode` 不进入 annotation；路线海拔由应用按地形数据临时采样，不写回工程。节点层级只允许 folder 作为父节点，并且不允许循环。

外部交换格式为 KML 2.2，支持 Folder、Placemark、Point、LineString、StyleMap 与 Google `gx:CascadingStyle`。KML 的 AABBGGRR 颜色会转换为 RGB；透明度、线宽与外部图标链接不导入、不导出。导入后立即转换为 JSON，不保存 `sourceKml`、`sourceXml` 或 `kmlDocumentXml`；旧工程读取时也会剥离这些遗留字段。

description 只保存地点本身有用的信息，不保存参考坐标、来源字段、外部 URL、免责声明、通用提醒或助手说明。描述按纯文本显示，不执行其中的 HTML。

节点自身及其所有父分组都可见时才在地图上显示。隐藏数据仍会保存和导出。地名使用 11px、常规字重、约 68% 不透明度的黑体，不绘制底框；发生文字遮挡时，在屏幕坐标的重心绘制小点并在旁边纵向列出地点。聚合只影响显示，不改写坐标或合并数据。

最小节点示例：

```json
{
  "id": "route-01",
  "parentId": null,
  "kind": "route",
  "name": "主线 01",
  "visible": true,
  "coordinates": [[101.85,30.15],[101.86,30.16]],
  "color": "#1976d2"
}
```

为便于人工检查，工程 JSON 使用两空格缩进，但每个完整坐标序列只占一行。字段顺序不构成语义；节点顺序构成同级显示顺序。

内部工程是当前支持范围内的完整保存格式。KML 导出从 JSON 生成名称、描述、可见性、点线坐标与颜色；Google 私有扩展、相机视角、悬停样式等未映射内容不再保留。暂不支持多边形、MultiGeometry、NetworkLink、gx:Track、KMZ 或 Google Earth 演示动画；遇到不支持的 Placemark 几何会明确报错，不静默丢弃。

## 操作

1. 启动时计算 `RawData/annotations/annotations.json` 的内容指纹；RawData 变化时优先载入新版，否则读取 Electron userData 下自动保存的 `annotations.json`。它与 CSV 足迹数据独立加载。
2. 左侧“我的地图”可展开分组、开关显示、选中定位，以及修改名称、描述、分组与颜色。删除分组同时删除后代；导入时选择的外部源文件不受影响。
3. 顶部“标点”后点击地图；“画路线”后逐点点击，Enter 或“完成”结束，Esc 取消；“撤回一点”移除草稿末点。
4. 选中地标可修改经纬度；选中点或不超过 200 个顶点的路线时显示可拖动的坐标手柄。更长的导入路线可编辑属性，暂不显示全部顶点手柄。
5. 更改在停止编辑 600 ms 后自动保存到本机，界面显示保存状态。等待“已自动保存到本机”后关闭窗口。保存串行且通过临时文件重命名替换。
6. “导入 KML / 项目”替换当前地图标注；需要保留多个版本时先“导出项目”。“导出 KML”可重新载入 Google Earth。
