/**
 * Squarified treemap layout (Bruls, Huizing, van Wijk). Coordinates are
 * percentages of the container, so the caller can position plain divs and
 * resize without recomputing.
 */

export interface TreemapInput {
  key: string;
  value: number;
}

export interface TreemapRect {
  key: string;
  /** Percentages, 0–100. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Area {
  key: string;
  area: number;
}

function worst(areas: number[], sum: number, side: number): number {
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  if (min <= 0 || sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(
    (side * side * max) / (sum * sum),
    (sum * sum) / (side * side * min),
  );
}

function layoutRow(
  row: Area[],
  state: { x: number; y: number; w: number; h: number },
  output: TreemapRect[],
) {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (sum <= 0) return;

  if (state.w >= state.h) {
    const rowWidth = sum / state.h;
    let offset = state.y;
    for (const item of row) {
      const itemHeight = item.area / rowWidth;
      output.push({
        key: item.key,
        x: state.x,
        y: offset,
        width: rowWidth,
        height: itemHeight,
      });
      offset += itemHeight;
    }
    state.x += rowWidth;
    state.w -= rowWidth;
  } else {
    const rowHeight = sum / state.w;
    let offset = state.x;
    for (const item of row) {
      const itemWidth = item.area / rowHeight;
      output.push({
        key: item.key,
        x: offset,
        y: state.y,
        width: itemWidth,
        height: rowHeight,
      });
      offset += itemWidth;
    }
    state.y += rowHeight;
    state.h -= rowHeight;
  }
}

export function squarify(
  items: TreemapInput[],
  width = 100,
  height = 100,
): TreemapRect[] {
  const total = items.reduce(
    (sum, item) => sum + (Number.isFinite(item.value) ? Math.max(0, item.value) : 0),
    0,
  );
  if (total <= 0 || width <= 0 || height <= 0) return [];

  const scale = (width * height) / total;
  const areas: Area[] = items
    .map((item) => ({
      key: item.key,
      area: Math.max(0, Number.isFinite(item.value) ? item.value : 0) * scale,
    }))
    .filter((item) => item.area > 0)
    .sort((a, b) => b.area - a.area);

  const output: TreemapRect[] = [];
  const state = { x: 0, y: 0, w: width, h: height };
  let index = 0;

  while (index < areas.length && state.w > 0 && state.h > 0) {
    const side = Math.min(state.w, state.h);
    const row: Area[] = [];
    let rowSum = 0;
    let best = Number.POSITIVE_INFINITY;

    while (index < areas.length) {
      const candidate = areas[index] as Area;
      const candidateAreas = [...row.map((item) => item.area), candidate.area];
      const candidateSum = rowSum + candidate.area;
      const ratio = worst(candidateAreas, candidateSum, side);
      if (row.length > 0 && ratio > best) break;
      row.push(candidate);
      rowSum = candidateSum;
      best = ratio;
      index += 1;
    }

    layoutRow(row, state, output);
  }

  return output;
}

/** True when `path` is `parent` itself or lives inside it (Windows paths). */
export function isSameOrInside(path: string, parent: string): boolean {
  const normalize = (value: string) =>
    value.replace(/[\\/]+$/, "").toLowerCase();
  const child = normalize(path);
  const root = normalize(parent);
  if (!root) return false;
  return child === root || child.startsWith(`${root}\\`) || child.startsWith(`${root}/`);
}

/** `C:\Users\lq` → `C:` / `Users` / `lq`, each with the path to open. */
export function pathCrumbs(path: string): Array<{ label: string; path: string }> {
  const value = path.replace(/[\\/]+$/, "");
  if (!value) return [];
  const root = `${value.slice(0, 2).toUpperCase()}\\`;
  const parts = value.slice(2).split(/[\\/]/).filter(Boolean);
  const crumbs = [{ label: root.replace("\\", ""), path: root }];
  let current = root;
  for (const part of parts) {
    current = current.endsWith("\\") ? `${current}${part}` : `${current}\\${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
