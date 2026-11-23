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

回放时能提前读到后续数据，估计某一帧时可以只看这一帧附近的过去和未来。可以把它理解成在线定位多等一小段时间，用刚收到的定位修正前几秒，然后输出。正常定位时，第五分钟的定位点不应该改变第一分钟的转弯，即使它们恰好在同一个五分钟文件块里。

当前实现的五分钟是求解块大小。每个观测只直接影响附近四个样条系数，运动平滑项只连相邻三个系数，但整块联立求解仍会间接传递影响，相机安装角也由整块共用。当前实现还没有明确限制每帧能看到多远的数据。

- **定位密集时**，周围锚点把误差压在局部。用 1 Hz、10 m/s 的直线 GPS 序列做实验，无姿态输入。只把正中央的一个定位向北移 10 米，拟合轨迹在该点、前后 1 秒、2 秒、5 秒和 10 秒处的横向变化绝对值分别约为 **6.66 米、2.21 米、0.45 米、0.006 米和 0.00004 米**。这组数字只描述这个受控输入。
- **定位缺口或姿态标定不确定时**，较远的锚点更重要。相机安装角由一整窗的数据估计，也会把影响带到窗内较远的时刻。项目现有测试留出一个 38 秒的合成弯道缺口，GPS 基线、仅 GPS 的样条、加入姿态的样条，平面位置 RMSE 分别为 **56.97、56.50、31.08 米**。姿态改善了估计，缺口里仍有几十米误差。见[回归用例](https://github.com/Wild-Donkey/ReplayMod_Reality/blob/0fd2f68/source/tests/media/check-gps-motion.cjs)。

下一版可以用短滑窗估计每个局部，保留中间较稳定的结果。正常时窗口内包含目标时刻前后的几个可靠 GPS 点。遇到定位缺口时，只为找到缺口两端的可靠锚点扩大窗口，并设时间上限。超过上限就标低可信。相机安装角和时间偏移可单独标定，固定下来后再做局部求解，避免远处的坏点通过共享参数拉偏当前轨迹。

验收时固定安装角和时间偏移，只扰动或删掉第五分钟的点，检查第一分钟的路径和速度。再移动处理块的边界，检查同一时刻的结果是否一致。具体看前后多少秒，用不同定位间隔、弯道和缺口长度来定。

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

## 实现横评

| 实现 | 离群点怎样处理 | 定位缺口怎样处理 | 对本项目的参考 |
| --- | --- | --- | --- |
| Google Roads / 高德轨迹纠偏 / 百度鹰眼 | 通过道路或轨迹纠偏服务约束结果，公开接口未给出各自的残差损失。 | Google 可补道路几何。百度对长中断提供直线等里程补偿选项。几何或里程补偿无法单独恢复带时间戳的位置。 | 适合做有地图基线。可用公开输入输出做对照，内部拒绝逻辑未知。[Google Roads](https://developers.google.com/maps/documentation/roads/snap) · [高德](https://lbs.amap.com/api/webservice/guide/api/grasproad) · [百度](https://lbs.baidu.com/docs/harmony?title=harmony-yingyan/guide/searchtrack) |
| Mapbox Navigation SDK | 以原始位置和道路、路线推断改进位置，无法改善时可回传原始输入。 | 文档称可缓解隧道失去信号，给出跟随路线的预测关键点，公开说明未给出惯导细节。 | 可借鉴原始位置与派生位置分开保留。[Mapbox](https://docs.mapbox.com/android/navigation/v2/guides/device-location/) |
| OSRM Match / Newson–Krumm HMM | 用道路候选和相邻转移约束识别偏离。OSRM 文档说明无法匹配的离群点会被丢弃。 | OSRM 在无法形成完整匹配时，可因过大的时间间隔或不合理的转移拆成子轨迹。 | 可信度可以用前后关系判断，长缺口允许断开。OSRM 和论文各自有实现口径。[OSRM Match](https://project-osrm.org/docs/v5.24.0/api/#match-service) · [Newson–Krumm](https://www.microsoft.com/en-us/research/publication/hidden-markov-map-matching-noise-sparseness/) |
| KF-GINS | 用显式位置、速度、姿态和 IMU 偏置做扩展卡尔曼滤波。 | GNSS 缺失时依赖惯性传播，恢复后用定位修正。需要合适的 IMU 和标定。 | 可以借鉴运动状态拆分。现有 DJI 输入主要提供方向，还缺独立的沿程速度观测。[KF-GINS](https://github.com/i2Nav-WHU/KF-GINS) · [道路隧道惯导实验](https://uis.brage.unit.no/uis-xmlui/bitstream/handle/11250/3117550/Rodriguez-Inertial-Navigation-ITSC2023-fulltext.pdf?sequence=1) |
| Wen 等人的离线 GNSS 因子图 | 用逐步非凸优化和截断最小二乘估计各 GNSS 观测的权重，在香港城市峡谷数据上验证。 | 论文提供多路径和非视距污染下的鲁棒估计证据。对没有可用观测的长隧道，仍须靠其他观测或运动先验。 | 与本项目最接近的是离线联合求解和逐步降低离群值权重。论文用 GNSS 伪距，现有 CSV 只有位置解，选取特征时要区分。[论文](https://arxiv.org/abs/2109.00667) |
| ReplayMod Reality 当前实现 | 平面样条对东、北残差分别使用 4 米 Huber 阈值，损失尾部继续线性增长。 | 使用 GPS 锚点、运动平滑和可用的 DJI 航向产生连续估计。 | 离线可以用缺口前后的信息，目前还没有对整段 GPS 失真的显式建模。 |

## 离群点怎么处理

### 单点误差按米给损失

看的是 GPS 点离拟合轨迹多少米。几厘米到几十厘米可以几乎不罚，几米的偏差逐渐加罚，大到明显可疑时就封顶。定位本来就容易飘的素材，可以把过渡区放宽。具体从几米起涨、到几米封顶，要看这批数据。

先试一条简单的 S 形曲线就够了。设起罚距离为 $a$ 米，封顶距离为 $b$ 米，损失上限为 $C$。在 $a$ 米以内损失为 0，$b$ 米以外为 $C$。中间可以用 $Ct^2(3-2t)$，其中 $t=(d-a)/(b-a)$，$d$ 是以米计的偏差。曲线在两端接平，超大偏差继续变远也不会多拉轨迹。

### 连续两点偏向同一侧时，加重代价

一个好点偶尔会飘。两个相邻好点如果同时偏向同侧、距离也差不多，说明拟合可能漏了一个真实转弯。损失可以设计成单点为 1，两个分开的点共 2，连续同向两点为 4，第三个同向点加到 4.5。这些数字只说明想要的关系，实际权重等测试再定。重复定位只计一次，间隔过大的点各自算。

### 整段定位漂移时，一起降权

如果隧道里几十个点一起飘，单点封顶后加起来仍可能很大，这时应该给整段降权，并停用连续同向加罚。可以用入口前和出口后的可靠轨迹往缺口里推，辅以可信的 DJI 航向。判断坏段时看时间戳停滞、跳速、掉头和出入口能否接上。有定位质量字段就加进来。没有独立速度或其他位置证据时，缺口内的位置可能有多种合理解，结果应标为低可信。

验证时分别看孤立跳点、两点同向偏离、一整段漂移和真实转弯，检查能否压住坏点、保住真弯。这些是待验证的设计，当前求解器还没接入。
