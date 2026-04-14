"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { polygon3857ToLocalXZ } from "@/lib/cadastre/polygon3857ToLocal";
import type { GeoJsonFeature } from "@/lib/cadastre/nspdSearch";
import { isPolygonGeometry } from "@/lib/cadastre/nspdSearch";

export type ParcelBaseData = {
  cadNum: string;
  address: string | null;
  specifiedAreaM2: number | null;
  /** Локальное кольцо XZ (м), центр участка в начале координат сцены. */
  ringClosedXZ: [number, number][];
  fitRadiusM: number;
  center3857: { x: number; y: number };
  loadedAt: number;
};

interface ParcelBaseState {
  parcel: ParcelBaseData | null;
  /** Смена ключа заставляет IfcViewport перефокусировать камеру. */
  focusGeneration: number;
  streetLineEdgeIndex: number | null;
  applyFeature: (feature: GeoJsonFeature) => void;
  setStreetLineEdgeIndex: (index: number | null) => void;
  clear: () => void;
}

function readOptions(props: Record<string, unknown> | undefined): {
  cad: string;
  address: string | null;
  area: number | null;
} {
  if (!props) return { cad: "", address: null, area: null };
  const opt = props.options as Record<string, unknown> | undefined;
  const cad =
    (typeof opt?.cad_num === "string" && opt.cad_num) ||
    (typeof props.label === "string" && props.label) ||
    (typeof props.descr === "string" && props.descr) ||
    "";
  const address =
    typeof opt?.readable_address === "string" ? opt.readable_address : null;
  const raw = opt?.specified_area;
  const area =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string"
        ? parseFloat(raw)
        : null;
  return { cad, address, area: area != null && !Number.isNaN(area) ? area : null };
}

export const useParcelBaseStore = create<ParcelBaseState>()(
  persist(
    (set) => ({
      parcel: null,
      focusGeneration: 0,
      streetLineEdgeIndex: null,

      applyFeature: (feature) => {
        if (!isPolygonGeometry(feature.geometry)) return;
        const outer = feature.geometry.coordinates[0];
        if (!outer?.length) return;
        const { ringClosedXZ, fitRadiusM, center3857 } = polygon3857ToLocalXZ(outer);
        const props = feature.properties as Record<string, unknown> | undefined;
        const { cad, address, area } = readOptions(props);
        const parcel: ParcelBaseData = {
          cadNum: cad || "—",
          address,
          specifiedAreaM2: area,
          ringClosedXZ,
          fitRadiusM,
          center3857,
          loadedAt: Date.now(),
        };
        set((s) => ({
          parcel,
          focusGeneration: s.focusGeneration + 1,
          streetLineEdgeIndex: null,
        }));
      },
      setStreetLineEdgeIndex: (index) => set({ streetLineEdgeIndex: index }),

      clear: () =>
        set({
          parcel: null,
          streetLineEdgeIndex: null,
        }),
    }),
    {
      name: "gravio-parcel-base-v1",
      partialize: (s) => ({
        parcel: s.parcel,
        streetLineEdgeIndex: s.streetLineEdgeIndex,
      }),
    },
  ),
);
