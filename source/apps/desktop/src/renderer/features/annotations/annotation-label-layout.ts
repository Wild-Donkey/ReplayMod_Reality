/** Screen-space overlap uses the actual label width, rather than a fixed geographic radius. */
export interface LabelItem {
  id: string;
  name: string;
  x: number;
  y: number;
}
export interface LabelGroup {
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
export function layoutAnnotationLabels(items: LabelItem[], measure: (text: string) => number): LabelGroup[] {
  const makeGroup = (members: LabelItem[]): LabelGroup => {
    const x = members.reduce((sum, item) => sum + item.x, 0) / members.length;
    const y = members.reduce((sum, item) => sum + item.y, 0) / members.length;
    const clustered = members.length > 1;
    const width = clustered
      ? 10 + Math.min(160, Math.max(...members.map(item => measure(labelText(item) || item.name))))
      : 10 + measure(labelText(members[0]));
    const height = clustered ? Math.min(3, members.length) * 14 : 16;
    const left = x - 4;
    return { items: members, x, y, width, left, right: left + width, top: y - height / 2, bottom: y + height / 2 };
  };
  const intersects = (a: LabelGroup, b: LabelGroup) => a.left < b.right + 3 && a.right + 3 > b.left && a.top < b.bottom + 3 && a.bottom + 3 > b.top;
  let groups = items.map(item => makeGroup([item]));
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
    groups = Array.from(buckets.values(), makeGroup);
  }
}
