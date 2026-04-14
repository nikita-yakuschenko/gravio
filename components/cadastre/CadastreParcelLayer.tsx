"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { useParcelBaseStore } from "@/store/parcelBaseStore";
import { VIEWPORT_OUTDOOR_SPEC } from "@/lib/viewportOutdoorSpec";

const TERRAIN_WORLD_Y_OFFSET = VIEWPORT_OUTDOOR_SPEC.ground.planeY + 0.012;
const BORDER_SURFACE_OFFSET = 0.12;

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
    const ring = parcel.ringClosedXZ.slice(0, -1);
    const points: THREE.Vector3[] = [];
    const segmentStepM = 1.25;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const ax = a[0];
      const az = -a[1];
      const bx = b[0];
      const bz = -b[1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / segmentStepM));
      const maxJ = i === ring.length - 1 ? steps : steps - 1;
      for (let j = 0; j <= maxJ; j += 1) {
        const t = steps === 0 ? 0 : j / steps;
        const x = ax + (bx - ax) * t;
        const worldZ = az + (bz - az) * t;
        const y =
          sampleTerrainHeight(terrainField, x, worldZ) +
          TERRAIN_WORLD_Y_OFFSET +
          BORDER_SURFACE_OFFSET;
        points.push(new THREE.Vector3(x, y, worldZ));
      }
    }
    if (points.length > 0) points.push(points[0].clone());
    return points;
  }, [parcel?.ringClosedXZ, terrainField?.size, terrainField?.resolution, terrainField?.heights]);

  if (!parcel || outlinePoints.length < 2) return null;

  return (
    <Line
      points={outlinePoints}
      color="#ffd400"
      lineWidth={5}
      dashed={false}
      renderOrder={12}
      depthTest
      transparent={false}
      opacity={1}
    />
  );
}
