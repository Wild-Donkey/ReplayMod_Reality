/** Screen-space overlap uses the actual label width, rather than a fixed geographic radius. */
export interface LabelItem {
  id: string;
  name: string;
  x: number;
  y: number;
}
export interface LabelGroup {
  side: "left" | "right";
  items: LabelItem[];
  x: number;
  y: number;
  width: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const labelText = (item: LabelItem) => item.name === "未命名地标" ? "" : item.name;
export const pointLabelText = labelText;
export function layoutAnnotationLabels(items: LabelItem[], measure: (text: string) => number, viewportWidth = Infinity): LabelGroup[] {
  const makeGroup = (members: LabelItem[], side: "left" | "right" = "right"): LabelGroup => {
    const x = members.reduce((sum, item) => sum + item.x, 0) / members.length;
    const y = members.reduce((sum, item) => sum + item.y, 0) / members.length;
    const clustered = members.length > 1;
    const width = clustered
      ? 10 + Math.min(160, Math.max(...members.slice(0, 3).map(item => measure(labelText(item) || item.name))) + (members.length > 3 ? measure(` +${members.length - 3}`) : 0))
      : 10 + measure(labelText(members[0]));
    const height = clustered ? Math.min(3, members.length) * 14 : 16;
    if (x + width > viewportWidth && x - width >= 0) side = "left";
    const left = side === "right" ? x - 4 : x + 4 - width;
    return { side, items: members, x, y, width, left, right: left + width, top: y - height / 2, bottom: y + height / 2 };
  };
  // The marker stays at the coordinate; only the text needs a free side.
  // Including the marker in this box prevents opposite-side labels from
  // separating when their nearby markers have overlapping hit areas.
  const textBounds = (group: LabelGroup) => ({
    left: group.left + (group.side === "right" ? (group.items.length > 1 ? 10 : 8) : 0),
    right: group.right - (group.side === "left" ? (group.items.length > 1 ? 10 : 8) : 0),
  });
  const intersects = (a: LabelGroup, b: LabelGroup) => {
    const at = textBounds(a), bt = textBounds(b);
    const sameMarker = Math.hypot(a.x - b.x, a.y - b.y) < 6;
    return sameMarker || (at.left < bt.right + 3 && at.right + 3 > bt.left && a.top < b.bottom + 3 && a.bottom + 3 > b.top);
  };
  let groups = [...items].sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id)).map(item => makeGroup([item]));
  const position = (group: LabelGroup, side: "left" | "right") => makeGroup(group.items, side);
  // Try both anchors before combining names. A flip must clear all other labels
  // and point markers, so moving text cannot hide a neighbouring place.
  const canPlace = (candidate: LabelGroup, index: number) => candidate.left >= 0 && candidate.right <= viewportWidth &&
    groups.every((other, j) => j === index || !intersects(candidate, other)) &&
    items.every(item => candidate.items.some(member => member.id === item.id) ||
      !(item.x > textBounds(candidate).left - 3 && item.x < textBounds(candidate).right + 3 && item.y > candidate.top - 3 && item.y < candidate.bottom + 3));
  for (let i = 0; i < groups.length; i++) {
    if (!groups.some((other, j) => i !== j && intersects(groups[i], other))) continue;
    const flipped = position(groups[i], groups[i].side === "right" ? "left" : "right");
    if (canPlace(flipped, i)) groups[i] = flipped;
  }
  // Merge connected overlaps simultaneously so the result does not depend on DOM ordering.
  for (;;) {
    const parents = groups.map((_, i) => i);
    const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]));
    let merged = false;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      if (intersects(groups[i], groups[j])) {
        const a = find(i), b = find(j);
        if (a !== b) { parents[b] = a; merged = true; }
      }
    }
    if (!merged) return groups;
    const buckets = new Map<number, LabelItem[]>();
    groups.forEach((group, i) => { const root = find(i); buckets.set(root, [...(buckets.get(root) ?? []), ...group.items]); });
    groups = Array.from(buckets.values(), members => {
      const previous = groups.find(group => group.items.length === members.length && group.items.every(item => members.includes(item)));
      return makeGroup(members, previous?.side);
    });
  }
}
