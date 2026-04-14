/** Перевод кольца EPSG:3857 в локальные координаты сцены XZ (метры), центр — центроид вершин. */

export type LocalParcelGeometry = {
  /** Замкнутое кольцо в плоскости XZ, первая точка = последняя (для линии/заливки). */
  ringClosedXZ: [number, number][];
  /** Радиус охвата от (0,0) в метрах — для кадрирования камеры. */
  fitRadiusM: number;
  /** Центр исходного полигона в EPSG:3857 (м) — нужен для запросов рельефа. */
  center3857: { x: number; y: number };
};

function ringCentroid3857(ringOpen: number[][]): { cx: number; cy: number } {
  let sx = 0;
  let sy = 0;
  for (const p of ringOpen) {
    sx += p[0];
    sy += p[1];
  }
  const n = ringOpen.length;
  return { cx: sx / n, cy: sy / n };
}

function openRing(ring: number[][]): number[][] {
  if (
    ring.length > 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  ) {
    return ring.slice(0, -1);
  }
  return ring.slice();
}

/** Mercator X → Three X; Mercator Y (север) → Three Z. */
export function polygon3857ToLocalXZ(outerRing3857: number[][]): LocalParcelGeometry {
  const open = openRing(outerRing3857);
  const { cx, cy } = ringCentroid3857(open);
  const localOpen: [number, number][] = open.map(([x, y]) => [x - cx, y - cy] as [number, number]);
  let fit = 1;
  for (const [lx, lz] of localOpen) {
    fit = Math.max(fit, Math.hypot(lx, lz));
  }
  const ringClosedXZ: [number, number][] = [...localOpen, localOpen[0]!];
  return { ringClosedXZ, fitRadiusM: fit, center3857: { x: cx, y: cy } };
}
