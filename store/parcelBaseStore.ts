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

export type TerrainStatus = "idle" | "loading" | "ready" | "error";
export type TerrainSource = "open-elevation" | "opentopodata" | "unknown" | null;
export type TerrainProviderPref = "open-elevation" | "opentopodata";
export type TerrainField = {
  size: number;
  resolution: number;
  heights: number[]; // row-major, resolution * resolution
};

interface ParcelBaseState {
  parcel: ParcelBaseData | null;
  /** Смена ключа заставляет IfcViewport перефокусировать камеру. */
  focusGeneration: number;
  terrainStatus: TerrainStatus;
  terrainMessage: string | null;
  terrainSource: TerrainSource;
  terrainProviderPref: TerrainProviderPref;
  terrainEnabled: boolean;
  terrainField: TerrainField | null;
  applyFeature: (feature: GeoJsonFeature) => void;
  setTerrainStatus: (status: TerrainStatus, message?: string | null, source?: TerrainSource) => void;
  setTerrainProviderPref: (pref: TerrainProviderPref) => void;
  setTerrainEnabled: (enabled: boolean) => void;
  setTerrainField: (field: TerrainField | null) => void;
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
      terrainStatus: "idle",
      terrainMessage: null,
      terrainSource: null,
      terrainProviderPref: "opentopodata",
      terrainEnabled: false,
      terrainField: null,

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
          terrainStatus: "loading",
          terrainMessage: "Загружаем рельеф...",
          terrainSource: null,
          terrainField: null,
        }));
      },

      setTerrainStatus: (status, message = null, source = null) =>
        set({ terrainStatus: status, terrainMessage: message, terrainSource: source }),
      setTerrainProviderPref: (pref) => set({ terrainProviderPref: pref }),
      setTerrainEnabled: (enabled) => set({ terrainEnabled: enabled }),
      setTerrainField: (field) => set({ terrainField: field }),

      clear: () =>
        set({
          parcel: null,
          terrainStatus: "idle",
          terrainMessage: null,
          terrainSource: null,
          terrainField: null,
        }),
    }),
    {
      name: "gravio-parcel-base-v1",
      partialize: (s) => ({ parcel: s.parcel }),
    },
  ),
);
