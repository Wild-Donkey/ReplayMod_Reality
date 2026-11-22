export function formatMediaTime(timeMs: number, includeDate = false) {
  const date = new Date(Math.round(timeMs));
  const time = date.toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"});
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const prefix = includeDate ? `${date.toLocaleDateString("zh-CN", {year: "numeric", month: "2-digit", day: "2-digit"})} ` : "";
  return `${prefix}${time}.${milliseconds}`;
}
