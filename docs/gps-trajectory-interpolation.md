# GPS 轨迹插值与 DJI 姿态约束

本文记录 ReplayMod Reality 在 `0fd2f68` 的离线轨迹拟合，以及 2026-11-23 查到的公开导航接口和算法。时钟对齐单独记录在 [DJI 视频、GPS 与姿态时间对齐实验](media-time-alignment-research.md)。

## 输入、输出和采样率

- **GPS 定位点**给出带绝对时间的位置。读取视频区间及前后至少各约 25 秒的数据；如果定位点稀疏，再向外多取，尽量每侧包含 8 个不同的定位时刻。窗外点进入拟合的初值或用于边界附近的观测，最终只替换视频时段的派生轨迹。
- **DJI 视频姿态**用 ExifTool 从元数据提取带时间戳的四元数。以对齐后的片头时间为原点，把 GPS 变换到与视频姿态相同的相对时间轴。提取的四元数表示姿态，陀螺仪原始输出则表示角速度。现有求解器使用四元数的水平偏航，未引入原始角速度或加速度积分。
- **输出轨迹**是平面位置关于时间的三次 B 样条，按约 10 Hz 取样，含视频的首尾点。另保留前后各 4 秒的派生采样供速度等指标计算。海拔单独线性插值。10 Hz 是派生序列的密度。没有可用定位锚点时回退到原有处理结果。

同一条素材中可以有多个频率。之前记录的一段 Osmo Action 4 视频解出了 **25 Hz 姿态**，对应搜索上下文里的足迹 CSV 定位间隔中位数是 **6 秒（约 0.17 Hz）**，二者相差约 **150 倍**。这是单段素材的姿态与轨迹文件实测，原始陀螺仪的硬件采样率未知。参见[实测记录](media-time-alignment-research.md#实际数据)。

## 当前怎样拟合

以第一个有效定位为局部原点，把经纬度换算为东、北向米坐标。样条系数每秒布一个节点，任意时刻的位置和一阶导数各由附近四个系数给出。先用 GPS 基线初始化，再最小化以下损失的加权和。

| 约束 | 加入损失的残差 |
| --- | --- |
| GPS 位置 | 样条位置和实际定位点的差。东、北两个方向分别用 4 米 Huber 阈值，减弱异常定位的影响。 |
| 运动平滑 | 相邻三个样条系数的二阶差分，抑制加速度突变。 |
| 基线先验 | 样条系数与初值之差，给予较弱权重，在约束不足时稳定求解。 |
| 相机姿态 | 将样条速度投影到相机校准航向的横向，目标为零。纵向给一个弱速度先验，降低反向解的风险。 |

每窗用覆盖充分的 GPS 位移段校准相机偏航与行进方向之间的符号和固定安装角。超过 0.25 秒的姿态缺口不跨越插值。校准通过后，每秒尝试添加一次速度方向约束，低速、疑似反向、姿态缺失或一秒内转动过急时跳过。原始姿态越密，越容易评估这一秒的覆盖和变化，求解器仍然每秒最多添加一次方向约束。校准不通过的窗口仍用 GPS、基线和运动平滑拟合。

每窗最多 **300 秒**，步长 **240 秒**，通常与下一窗重叠 **60 秒**。求解使用带状正规方程和三轮 Huber 迭代重加权。重叠区在同一时刻对两窗位置加权，后窗权重为 $w(u)=3u^2-2u^3$，其中 $u$ 是重叠区内归一化时间。权重在两端的一阶导数为零，因此与单窗相接时不会单因切换窗口引入速度跳变。只有单侧定位时，以最近的 GPS 位置作为初值先验，估计可能趋于静止。单靠方向也无法确定缺口内的位移和速度。

代码入口见 [样条拟合](https://github.com/Wild-Donkey/ReplayMod_Reality/blob/0fd2f68/source/packages/media/src/trajectory-fit.ts)、[窗外定位点选取](https://github.com/Wild-Donkey/ReplayMod_Reality/blob/0fd2f68/source/apps/desktop/src/renderer/features/timeline/processedTrajectory.ts) 和 [DJI 姿态读取](https://github.com/Wild-Donkey/ReplayMod_Reality/blob/0fd2f68/source/packages/media/src/dji.ts)。

## 局部性和马尔可夫假设

这个问题适合按局部运动建模。把位置、速度、航向和必要的传感器偏置放进状态 $x_k$ 后，可以假设给定 $x_k$ 和这段的惯性观测 $u_k$，下一状态只依赖它们。离线平滑仍可以同时使用目标时刻前后的 GPS。相邻状态直接耦合，观测的影响可以通过相邻状态间接传到更远处。参考 [GTSAM 的滤波和固定滞后平滑说明](https://borglab.github.io/gtsam/kalmanfilteringandsmoothing/)。

当前样条已经有类似的局部结构。每个观测只直接影响附近四个样条系数，运动平滑项只连相邻三个系数。求解器在整个窗口联立求解，所以没有严格的影响半径。两个情况尤其值得区分。

- **定位密集时**，周围锚点把误差压在局部。用 1 Hz、10 m/s 的直线 GPS 序列做实验，无姿态输入。只把正中央的一个定位向北移 10 米，拟合轨迹在该点、前后 1 秒、2 秒、5 秒和 10 秒处的横向变化绝对值分别约为 **6.66 米、2.21 米、0.45 米、0.006 米和 0.00004 米**。这组数字只描述这个受控输入。
- **定位缺口或姿态标定不确定时**，较远的锚点更重要。相机安装角由一整窗的数据估计，也会把影响带到窗内较远的时刻。项目现有测试留出一个 38 秒的合成弯道缺口，GPS 基线、仅 GPS 的样条、加入姿态的样条，平面位置 RMSE 分别为 **56.97、56.50、31.08 米**。姿态改善了估计，缺口里仍有几十米误差。见[回归用例](https://github.com/Wild-Donkey/ReplayMod_Reality/blob/0fd2f68/source/tests/media/check-gps-motion.cjs)。

若要决定能否缩小重算窗口，可以重复这个扰动实验，改变定位间隔、缺口长度、转弯幅度和离窗口边界的距离，再画误差随时间距离的衰减。若转用固定滞后平滑，窗口移走的旧状态可以边缘化成边界先验，窗口内保留双向修正。相机安装角和时间偏移应单独评估，因为它们对一段内的多个时刻同时生效。

## 导航软件公开了什么

比较时要分别看 **GNSS 观测率、系统或 SDK 的位置更新率、陀螺仪事件率、画面刷新率**。SDK 的请求间隔也可能与实际收到的位置间隔不同，例如 Android fused location 的文档说明实际回调可能比所请求的更快或更慢。下表的数字只适用于所列接口或数据。见 [Android LocationRequest](https://developers.google.com/android/reference/com/google/android/gms/location/LocationRequest.Builder)。

| 产品或资料 | 公开的采样或更新频率 | 公开的处理方式 |
| --- | --- | --- |
| 高德 HarmonyOS NEXT 导航 SDK | 默认每秒定位一次，可设置间隔。此处是 SDK 的定位周期。 | Web 端轨迹纠偏接受坐标、时间、航向与速度，返回纠偏结果。公开接口未给出导航客户端的惯性频率或融合算法。[定位设置](https://lbs.gaode.com/api/harmonyosnext-navi-sdk/guide/location-info/location-setting-callback) · [Web 轨迹纠偏](https://lbs.amap.com/api/webservice/guide/api/grasproad) |
| 百度鹰眼 Android SDK | 定位周期由开发者设置。文档称大于 15 秒时取整到 5 秒的倍数，另有独立的回传周期。 | 轨迹纠偏可选绑路，长时间中断有里程补偿选项。公开资料未给出百度地图客户端的陀螺仪率。[采集频率](https://lbsyun.baidu.com/docs/android?title=android-yingyan/guide/uploadtrack) · [轨迹纠偏](https://lbs.baidu.com/docs/harmony?title=harmony-yingyan/guide/searchtrack) |
| Google Maps Roads API | 请求输入已有位置序列，采样频率由调用方决定。文档建议相邻输入点距不超过 300 米。 | `interpolate=true` 补出完整道路几何，转弯和隧道也沿路形。返回的额外点描述几何，单靠它们无法确定车辆何时经过。[Snap to Roads](https://developers.google.com/maps/documentation/roads/snap) |
| Mapbox Navigation SDK v2 | 原始位置由默认或调用方提供的定位引擎送来，文档未给出固定的惯性频率。 | 将位置匹配到路线或道路，输出可供地图标记在转弯时跟随的预测关键点；无法改善时回传原始位置。[Location tracking](https://docs.mapbox.com/android/navigation/v2/guides/device-location/) |
| Apple Core Location / Core Motion | Apple 文档称陀螺仪的最大可请求频率依硬件而定，通常至少 **100 Hz**。Apple Maps 客户端的实际定位频率和陀螺仪频率未见公开。 | Core Location 使用多种硬件来源生成位置。公开接口未披露 Apple Maps 的插值或匹配实现。[Core Location](https://developer.apple.com/documentation/corelocation) · [Core Motion](https://developer.apple.com/documentation/coremotion/getting-raw-gyroscope-events) |
| Mobile-GVIO 公开采集数据 | **1 Hz GNSS、100 Hz IMU**，分别来自 iPhone 11 Pro Max 和一台 Honor 手机。 | 这个采集实例表明两个观测流可以相差两个数量级。该数字对应两台设备搭建的研究系统。[数据说明](https://zenodo.org/records/20525157) |

## 别人怎样补轨迹

**道路匹配补空间几何。** 公开的经典方法用隐马尔可夫模型给每个时间点选候选路段，观测分数衡量 GPS 点离路段多远，转移分数比较候选路段间的道路距离和观测位移，再找整条最可能的路段序列。地图能约束弯道和匝道形状。多条平行道路或 GPS 缺口很长时，仍可能匹配到错路，补出的几何也需要另行分配通过时间。见 [Newson & Krumm 的论文及实验数据](https://www.microsoft.com/en-us/research/publication/hidden-markov-map-matching-noise-sparseness/)。

**惯导融合填定位观测之间的时间。** 开源 KF-GINS 用高频 IMU 传播位置、速度和姿态，收到 GNSS 时用扩展卡尔曼滤波修正，同时估计 IMU 偏置等误差。如果 GNSS 修正时刻落在两次 IMU 之间，程序会先对齐到该时刻再更新。长时间缺少 GNSS 时，惯性误差会累积。对我们的素材，DJI 相机可能相对车身独立转动，目前只把可靠偏航用于软约束。见 [KF-GINS 说明](https://github.com/i2Nav-WHU/KF-GINS) 和 [时间对齐实现](https://github.com/i2Nav-WHU/KF-GINS/blob/main/src/kf-gins/gi_engine.cpp)。
