const fs = require('fs');
const path = require('path');

const input = path.resolve(process.argv[2] || '../RawData/footprint/2026.01.01-2026.12.31.csv');
const output = path.resolve(process.argv[3] || 'adjacent-distance-time.html');

const lines = fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
const header = lines[0].split(',').map((value) => value.trim());
const timeIndex = header.indexOf('dataTime');
const longitudeIndex = header.indexOf('longitude');
const latitudeIndex = header.indexOf('latitude');

if (timeIndex < 0 || longitudeIndex < 0 || latitudeIndex < 0) {
  throw new Error('CSV must contain dataTime, longitude, and latitude columns.');
}

const points = [];
for (let i = 1; i < lines.length; i += 1) {
  if (!lines[i].trim()) continue;
  const columns = lines[i].split(',');
  const time = Number(columns[timeIndex]);
  const longitude = Number(columns[longitudeIndex]);
  const latitude = Number(columns[latitudeIndex]);
  if (Number.isFinite(time) && Number.isFinite(longitude) && Number.isFinite(latitude)) {
    points.push({ time, longitude, latitude });
  }
}
points.sort((a, b) => a.time - b.time);

function haversine(a, b) {
  const radius = 6371008.8;
  const radians = Math.PI / 180;
  const dLatitude = (b.latitude - a.latitude) * radians;
  const dLongitude = (b.longitude - a.longitude) * radians;
  const latitudeA = a.latitude * radians;
  const latitudeB = b.latitude * radians;
  const h = Math.sin(dLatitude / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(dLongitude / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

const pairs = [];
let zeroOrNegativeTime = 0;
let zeroDistance = 0;
for (let i = 1; i < points.length; i += 1) {
  const seconds = points[i].time - points[i - 1].time;
  const metres = haversine(points[i - 1], points[i]);
  if (seconds <= 0) zeroOrNegativeTime += 1;
  if (metres <= 0) zeroDistance += 1;
  if (seconds > 0 && metres > 0 && Number.isFinite(metres)) pairs.push({ seconds, metres });
}

const sortedTime = pairs.map((d) => d.seconds).sort((a, b) => a - b);
const sortedDistance = pairs.map((d) => d.metres).sort((a, b) => a - b);
const quantile = (values, p) => {
  if (!values.length) return NaN;
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
};

const xMin = Math.max(0.1, sortedTime[0]);
const xMax = sortedTime[sortedTime.length - 1];
const yMin = Math.max(0.05, sortedDistance[0]);
const yMax = sortedDistance[sortedDistance.length - 1];
const xBins = 72;
const yBins = 56;
const xLogMin = Math.log10(xMin);
const xLogMax = Math.log10(xMax);
const yLogMin = Math.log10(yMin);
const yLogMax = Math.log10(yMax);
const bins = new Map();

for (const pair of pairs) {
  const xi = Math.min(xBins - 1, Math.max(0, Math.floor((Math.log10(pair.seconds) - xLogMin) / (xLogMax - xLogMin) * xBins)));
  const yi = Math.min(yBins - 1, Math.max(0, Math.floor((Math.log10(pair.metres) - yLogMin) / (yLogMax - yLogMin) * yBins)));
  const key = `${xi},${yi}`;
  bins.set(key, (bins.get(key) || 0) + 1);
}

const density = [...bins.entries()].map(([key, count]) => {
  const [xi, yi] = key.split(',').map(Number);
  return {
    seconds: 10 ** (xLogMin + (xi + 0.5) / xBins * (xLogMax - xLogMin)),
    metres: 10 ** (yLogMin + (yi + 0.5) / yBins * (yLogMax - yLogMin)),
    count,
  };
});

const statistics = {
  points: points.length,
  pairs: points.length - 1,
  plottedPairs: pairs.length,
  zeroOrNegativeTime,
  zeroDistance,
  timeMedian: quantile(sortedTime, 0.5),
  timeP90: quantile(sortedTime, 0.9),
  timeP99: quantile(sortedTime, 0.99),
  distanceMedian: quantile(sortedDistance, 0.5),
  distanceP90: quantile(sortedDistance, 0.9),
  distanceP99: quantile(sortedDistance, 0.99),
  withinFiveMinutes: pairs.filter((d) => d.seconds <= 300).length,
  overOneHour: pairs.filter((d) => d.seconds > 3600).length,
  overOneKilometre: pairs.filter((d) => d.metres > 1000).length,
};

const sourceName = path.basename(input);
const fragment = `<div id="adjacent-distance-time-viz">
  <style>
    #adjacent-distance-time-viz { color: var(--foreground); display: grid; gap: calc(var(--font-size-base) * 1); }
    #adjacent-distance-time-viz .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: calc(var(--font-size-base) * .75); }
    #adjacent-distance-time-viz .chart-wrap { position: relative; min-height: 420px; }
    #adjacent-distance-time-viz svg { width: 100%; display: block; overflow: visible; }
    #adjacent-distance-time-viz .axis text, #adjacent-distance-time-viz .axis-title { fill: var(--foreground); font-size: 12px; }
    #adjacent-distance-time-viz .axis path, #adjacent-distance-time-viz .axis line { stroke: var(--border); }
    #adjacent-distance-time-viz .grid line { stroke: var(--border); stroke-opacity: .45; }
    #adjacent-distance-time-viz .grid path { display: none; }
    #adjacent-distance-time-viz .plot-frame { fill: none; stroke: var(--border); }
    #adjacent-distance-time-viz .dot { fill: var(--viz-series-1); }
    #adjacent-distance-time-viz .tooltip { position: absolute; pointer-events: none; background: var(--popover); color: var(--popover-foreground); border: 1px solid var(--border); padding: 8px 10px; border-radius: 6px; opacity: 0; z-index: 2; font-size: 12px; }
    #adjacent-distance-time-viz .source { color: var(--muted-foreground); }
    @media (max-width: 520px) { #adjacent-distance-time-viz .summary { grid-template-columns: 1fr; } #adjacent-distance-time-viz .chart-wrap { min-height: 360px; } }
  </style>
  <div>
    <h1>相邻轨迹点：空间距离 × 时间间隔</h1>
    <p class="source text-small">${sourceName} · 每个圆代表一个对数区间，圆越大表示相邻点对越多</p>
  </div>
  <div class="summary">
    <div class="card viz-stat"><span class="text-small">有效相邻点对</span><span class="viz-stat-value tabular-nums" id="pair-count"></span><span class="text-small" id="pair-note"></span></div>
    <div class="card viz-stat"><span class="text-small">时间间隔中位数</span><span class="viz-stat-value tabular-nums" id="time-median"></span><span class="text-small" id="time-note"></span></div>
    <div class="card viz-stat"><span class="text-small">空间距离中位数</span><span class="viz-stat-value tabular-nums" id="distance-median"></span><span class="text-small" id="distance-note"></span></div>
  </div>
  <div class="chart-wrap" aria-label="相邻轨迹点空间距离与时间间隔密度散点图">
    <svg role="img" aria-labelledby="scatter-title scatter-desc"><title id="scatter-title">空间距离与时间间隔密度散点图</title><desc id="scatter-desc">横轴为相邻点时间间隔，纵轴为空间距离，均为对数坐标。圆越大代表该区间点对越多。</desc></svg>
    <div class="tooltip" role="tooltip"></div>
  </div>
  <p class="text-small source" id="quality-note"></p>
  <script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
  <script>
    (() => {
      const root = document.getElementById('adjacent-distance-time-viz');
      const data = ${JSON.stringify(density)};
      const stats = ${JSON.stringify(statistics)};
      const formatCount = new Intl.NumberFormat('zh-CN');
      const formatTime = (seconds) => seconds < 60 ? seconds.toFixed(seconds < 10 ? 1 : 0) + ' 秒' : seconds < 3600 ? (seconds / 60).toFixed(1) + ' 分钟' : seconds < 86400 ? (seconds / 3600).toFixed(1) + ' 小时' : (seconds / 86400).toFixed(1) + ' 天';
      const formatDistance = (metres) => metres < 1000 ? metres.toFixed(metres < 10 ? 1 : 0) + ' 米' : (metres / 1000).toFixed(1) + ' 千米';
      root.querySelector('#pair-count').textContent = formatCount.format(stats.plottedPairs);
      root.querySelector('#pair-note').textContent = '来自 ' + formatCount.format(stats.points) + ' 个轨迹点';
      root.querySelector('#time-median').textContent = formatTime(stats.timeMedian);
      root.querySelector('#time-note').textContent = 'P90 ' + formatTime(stats.timeP90) + ' · P99 ' + formatTime(stats.timeP99);
      root.querySelector('#distance-median').textContent = formatDistance(stats.distanceMedian);
      root.querySelector('#distance-note').textContent = 'P90 ' + formatDistance(stats.distanceP90) + ' · P99 ' + formatDistance(stats.distanceP99);
      root.querySelector('#quality-note').textContent = '另有 ' + formatCount.format(stats.zeroOrNegativeTime) + ' 对时间差≤0、' + formatCount.format(stats.zeroDistance) + ' 对位置完全重合，未进入对数坐标图。超过 1 小时的间隔有 ' + formatCount.format(stats.overOneHour) + ' 对，空间距离超过 1 千米的有 ' + formatCount.format(stats.overOneKilometre) + ' 对。';

      const svg = d3.select(root.querySelector('svg'));
      const wrap = root.querySelector('.chart-wrap');
      const tooltip = root.querySelector('.tooltip');
      const xDomain = d3.extent(data, (d) => d.seconds);
      const yDomain = d3.extent(data, (d) => d.metres);
      const maxCount = d3.max(data, (d) => d.count);
      function draw() {
        const width = Math.max(320, wrap.clientWidth);
        const height = width < 520 ? 360 : 440;
        const margin = { top: 16, right: 18, bottom: 58, left: 72 };
        const innerWidth = width - margin.left - margin.right;
        const innerHeight = height - margin.top - margin.bottom;
        svg.attr('viewBox', '0 0 ' + width + ' ' + height);
        svg.selectAll(':scope > g').remove();
        const plot = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');
        const x = d3.scaleLog().domain(xDomain).nice().range([8, innerWidth - 8]);
        const y = d3.scaleLog().domain(yDomain).nice().range([innerHeight - 8, 8]);
        const radius = d3.scaleSqrt().domain([1, maxCount]).range([1.5, width < 520 ? 8 : 11]);
        const opacity = d3.scaleLog().domain([1, maxCount]).range([0.25, 0.82]);
        const xTicks = x.ticks(width < 520 ? 4 : 7);
        const yTicks = y.ticks(width < 520 ? 5 : 7);
        plot.append('g').attr('class', 'grid').attr('transform', 'translate(0,' + innerHeight + ')').call(d3.axisBottom(x).tickValues(xTicks).tickSize(-innerHeight).tickFormat(''));
        plot.append('g').attr('class', 'grid').call(d3.axisLeft(y).tickValues(yTicks).tickSize(-innerWidth).tickFormat(''));
        plot.append('rect').attr('class', 'plot-frame').attr('data-chart-frame', '').attr('width', innerWidth).attr('height', innerHeight);
        const marks = plot.append('g').selectAll('circle').data(data).join('circle')
          .attr('class', 'dot').attr('cx', (d) => x(d.seconds)).attr('cy', (d) => y(d.metres))
          .attr('r', (d) => radius(d.count)).attr('fill-opacity', (d) => opacity(d.count));
        marks.on('pointerenter pointermove', (event, d) => {
          const bounds = wrap.getBoundingClientRect();
          tooltip.style.opacity = '1';
          tooltip.innerHTML = '<strong>' + formatCount.format(d.count) + ' 对</strong><br>时间约 ' + formatTime(d.seconds) + '<br>距离约 ' + formatDistance(d.metres);
          const left = Math.min(bounds.width - tooltip.offsetWidth - 8, Math.max(8, event.clientX - bounds.left + 12));
          const top = Math.min(bounds.height - tooltip.offsetHeight - 8, Math.max(8, event.clientY - bounds.top - tooltip.offsetHeight - 10));
          tooltip.style.left = left + 'px'; tooltip.style.top = top + 'px';
        }).on('pointerleave', () => { tooltip.style.opacity = '0'; });
        plot.append('g').attr('class', 'axis').attr('transform', 'translate(0,' + innerHeight + ')').call(d3.axisBottom(x).tickValues(xTicks).tickFormat(formatTime));
        plot.append('g').attr('class', 'axis').call(d3.axisLeft(y).tickValues(yTicks).tickFormat(formatDistance));
        svg.append('text').attr('class', 'axis-title').attr('data-axis', 'x').attr('x', margin.left + innerWidth / 2).attr('y', height - 10).attr('text-anchor', 'middle').text('相邻点时间间隔（对数刻度）');
        svg.append('text').attr('class', 'axis-title').attr('data-axis', 'y').attr('transform', 'translate(16,' + (margin.top + innerHeight / 2) + ') rotate(-90)').attr('text-anchor', 'middle').text('相邻点空间距离（对数刻度）');
      }
      draw();
      new ResizeObserver(draw).observe(wrap);
    })();
  </script>
</div>\n`;

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, fragment);
console.log(JSON.stringify({ input, output, statistics, densityBins: density.length }, null, 2));
