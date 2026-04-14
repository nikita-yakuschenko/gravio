"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { useParcelBaseStore } from "@/store/parcelBaseStore";

function sampleTerrainHeight(
  field: { size: number; resolution: number; heights: number[] } | null,
  x: number,
  z: number,
): number {
  if (!field || field.resolution < 2 || field.heights.length < field.resolution * field.resolution) return 0;
  const { size, resolution, heights } = field;
  const half = size / 2;
  const u = THREE.MathUtils.clamp((x + half) / size, 0, 1);
  const v = THREE.MathUtils.clamp((z + half) / size, 0, 1);
  const gx = u * (resolution - 1);
  const gz = v * (resolution - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, resolution - 1);
  const z1 = Math.min(z0 + 1, resolution - 1);
  const tx = gx - x0;
  const tz = gz - z0;

  const i00 = z0 * resolution + x0;
  const i10 = z0 * resolution + x1;
  const i01 = z1 * resolution + x0;
  const i11 = z1 * resolution + x1;
  const h00 = heights[i00] ?? 0;
  const h10 = heights[i10] ?? 0;
  const h01 = heights[i01] ?? 0;
  const h11 = heights[i11] ?? 0;
  const h0 = h00 * (1 - tx) + h10 * tx;
  const h1 = h01 * (1 - tx) + h11 * tx;
  return h0 * (1 - tz) + h1 * tz;
}

/** Подложка участка (полигон на «земле»), центр сцены = центроид участка. */
export function CadastreParcelLayer() {
  const parcel = useParcelBaseStore((s) => s.parcel);
  const terrainField = useParcelBaseStore((s) => s.terrainField);
  const outlinePoints = useMemo(() => {
    if (!parcel?.ringClosedXZ?.length) return [] as THREE.Vector3[];
    const open = parcel.ringClosedXZ.slice(0, -1);
    const points = open.map(([x, z]) => {
      const y = sampleTerrainHeight(terrainField, x, -z) + 0.075;
      return new THREE.Vector3(x, y, -z);
    });
    if (points.length > 0) points.push(points[0].clone());
    return points;
  }, [parcel?.ringClosedXZ, terrainField?.size, terrainField?.resolution, terrainField?.heights]);

  if (!parcel) return null;

  return (
    <Line points={outlinePoints} color="#ffd400" lineWidth={4} dashed={false} renderOrder={12} />
  );
}
