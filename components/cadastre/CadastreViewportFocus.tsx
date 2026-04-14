"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useParcelBaseStore } from "@/store/parcelBaseStore";

/** Кадрирует камеру на подложку участка после загрузки (центр сцены = центр участка). */
export function CadastreViewportFocus({
  controlsRef,
  viewMode,
}: {
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  viewMode: "2d" | "3d";
}) {
  const focusGeneration = useParcelBaseStore((s) => s.focusGeneration);
  const parcel = useParcelBaseStore((s) => s.parcel);
  const fitRadius = parcel?.fitRadiusM ?? 0;
  const loadedAt = parcel?.loadedAt ?? 0;
  const { camera, invalidate } = useThree();

  useEffect(() => {
    const p = useParcelBaseStore.getState().parcel;
    if (!p || p.fitRadiusM <= 0) return;

    let raf = 0;
    let cancelled = false;

    const apply = () => {
      if (cancelled) return;
      const controls = controlsRef.current;
      if (!controls) {
        raf = requestAnimationFrame(apply);
        return;
      }
      const persp = camera as THREE.PerspectiveCamera;
      const dist = Math.max(p.fitRadiusM * 2.35, 40);

      if (viewMode === "3d") {
        persp.position.set(dist * 0.72, dist * 0.52, dist * 0.72);
      } else {
        const h = Math.max(dist * 2.8, 200);
        persp.position.set(0, h, 0.01);
      }
      controls.target.set(0, 0, 0);
      persp.up.set(0, 1, 0);
      persp.lookAt(0, 0, 0);
      controls.update();
      invalidate();
    };

    raf = requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [focusGeneration, loadedAt, fitRadius, viewMode, camera, controlsRef, invalidate]);

  return null;
}
