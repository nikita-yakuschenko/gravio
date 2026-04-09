"use client";

import { create } from "zustand";
import {
  clearIfcRecords,
  deleteIfcRecord,
  getAllIfcRecords,
  upsertIfcRecord,
} from "@/lib/storage/ifcPersistence";
import type {
  IfcAnalysis,
  IfcAnalysisStatus,
  IfcGeometryStats,
  IfcGeometryStatus,
  IfcModelItem,
  IfcPlacement,
} from "@/types/ifc";

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10);
}

function patchModelById(
  models: IfcModelItem[],
  id: string,
  patch: Partial<IfcModelItem>,
): IfcModelItem[] {
  return models.map((model) => (model.id === id ? { ...model, ...patch } : model));
}

type HydrationStatus = "idle" | "loading" | "ready" | "error";

function defaultPlacement(): IfcPlacement {
  return { x: 0, y: 0, z: 0, rotationY: 0 };
}

interface IfcStoreState {
  models: IfcModelItem[];
  activeModelId: string | null;
  hydrationStatus: HydrationStatus;
  hydrateFromStorage: () => Promise<void>;
  addFiles: (files: File[]) => void;
  removeModel: (id: string) => void;
  setActiveModelId: (id: string | null) => void;
  setAnalysisResult: (id: string, analysis: IfcAnalysis) => void;
  setAnalysisError: (id: string, message: string) => void;
  setAnalysisStatus: (id: string, status: IfcAnalysisStatus) => void;
  setGeometryResult: (id: string, stats: IfcGeometryStats) => void;
  setGeometryError: (id: string, message: string) => void;
  setGeometryStatus: (id: string, status: IfcGeometryStatus) => void;
  placeModelOnCanvas: (id: string, placement: IfcPlacement) => void;
  spawnModelInstance: (sourceId: string, placement: IfcPlacement) => string | null;
  setModelPlacement: (id: string, placement: IfcPlacement) => void;
  persistModelPlacement: (id: string) => void;
  requestGeometryReload: (id: string) => void;
  clearModels: () => void;
}

function toPersistRecord(
  model: IfcModelItem,
  overrides?: { analysis?: IfcAnalysis; placement?: IfcPlacement },
) {
  return {
    id: model.id,
    name: model.name,
    size: model.size,
    addedAt: model.addedAt,
    lastModified: model.file.lastModified,
    fileBlob: model.file,
    analysis: overrides?.analysis ?? model.analysis,
    placement: overrides?.placement ?? model.placement,
    isPlaced: model.isPlaced,
  };
}

export const useIfcStore = create<IfcStoreState>((set, get) => ({
  models: [],
  activeModelId: null,
  hydrationStatus: "idle",

  hydrateFromStorage: async () => {
    const status = get().hydrationStatus;
    if (status === "loading" || status === "ready") return;

    set({ hydrationStatus: "loading" });

    try {
      const rows = await getAllIfcRecords();
      const sorted = rows.sort((a, b) => b.addedAt - a.addedAt);
      const models: IfcModelItem[] = sorted.map((row) => {
        const file = new File([row.fileBlob], row.name, {
          type: row.fileBlob.type || "application/octet-stream",
          lastModified: row.lastModified,
        });

        return {
          id: row.id,
          file,
          name: row.name,
          size: row.size,
          addedAt: row.addedAt,
          isPlaced: row.isPlaced ?? false,
          analysisStatus: row.analysis ? "ready" : "queued",
          analysis: row.analysis,
          geometryStatus: "idle",
          geometryRevision: 0,
          placement: row.placement ?? defaultPlacement(),
        };
      });

      set({
        models,
        activeModelId: models[0]?.id ?? null,
        hydrationStatus: "ready",
      });
    } catch (error) {
      console.error("IFC storage hydration failed", error);
      set({ hydrationStatus: "error" });
    }
  },

  addFiles: (files) => {
    const onlyIfc = files.filter((file) => file.name.toLowerCase().endsWith(".ifc"));
    if (onlyIfc.length === 0) return;

    const items: IfcModelItem[] = onlyIfc.map((file) => {
      const placement = defaultPlacement();
      return {
        id: makeId(),
        file,
        name: file.name,
        size: file.size,
        addedAt: Date.now(),
        isPlaced: false,
        analysisStatus: "queued",
        geometryStatus: "idle",
        geometryRevision: 0,
        placement,
      };
    });

    set((state) => ({
      models: [...items, ...state.models],
      activeModelId: state.activeModelId ?? items[0]?.id ?? null,
    }));

    for (const model of items) {
      void upsertIfcRecord(toPersistRecord(model)).catch((error) => {
        console.error("Failed to persist IFC file", error);
      });
    }
  },

  removeModel: (id) => {
    set((state) => {
      const models = state.models.filter((model) => model.id !== id);
      const nextActive = state.activeModelId === id ? (models[0]?.id ?? null) : state.activeModelId;
      return { models, activeModelId: nextActive };
    });

    void deleteIfcRecord(id).catch((error) => {
      console.error("Failed to delete IFC record", error);
    });
  },

  setActiveModelId: (id) => set({ activeModelId: id }),

  setAnalysisResult: (id, analysis) => {
    set((state) => ({
      models: patchModelById(state.models, id, {
        analysisStatus: "ready",
        analysis,
        analysisError: undefined,
      }),
    }));

    const model = get().models.find((row) => row.id === id);
    if (model) {
      void upsertIfcRecord(toPersistRecord(model, { analysis })).catch((error) => {
        console.error("Failed to persist IFC analysis", error);
      });
    }
  },

  setAnalysisError: (id, message) =>
    set((state) => ({
      models: patchModelById(state.models, id, {
        analysisStatus: "error",
        analysisError: message,
      }),
    })),

  setAnalysisStatus: (id, status) =>
    set((state) => ({
      models: patchModelById(state.models, id, { analysisStatus: status }),
    })),

  setGeometryResult: (id, stats) =>
    set((state) => ({
      models: patchModelById(state.models, id, {
        geometryStatus: "ready",
        geometryStats: stats,
        geometryError: undefined,
      }),
    })),

  setGeometryError: (id, message) =>
    set((state) => ({
      models: patchModelById(state.models, id, {
        geometryStatus: "error",
        geometryError: message,
      }),
    })),

  setGeometryStatus: (id, status) =>
    set((state) => ({
      models: patchModelById(state.models, id, {
        geometryStatus: status,
        geometryError: undefined,
      }),
    })),

  placeModelOnCanvas: (id, placement) => {
    set((state) => ({
      models: patchModelById(state.models, id, {
        placement,
        isPlaced: true,
      }),
      activeModelId: id,
    }));
  },

  spawnModelInstance: (sourceId, placement) => {
    const source = get().models.find((row) => row.id === sourceId);
    if (!source) return null;

    const instance: IfcModelItem = {
      ...source,
      id: makeId(),
      addedAt: Date.now(),
      isPlaced: true,
      placement: {
        x: placement.x,
        y: 0,
        z: placement.z,
        rotationY: placement.rotationY,
      },
      geometryStatus: source.analysisStatus === "ready" ? "idle" : source.geometryStatus,
      geometryStats: source.analysisStatus === "ready" ? undefined : source.geometryStats,
      geometryError: undefined,
    };

    set((state) => ({
      models: [instance, ...state.models],
      activeModelId: instance.id,
    }));

    void upsertIfcRecord(toPersistRecord(instance)).catch((error) => {
      console.error("Failed to persist IFC instance", error);
    });

    return instance.id;
  },

  setModelPlacement: (id, placement) =>
    set((state) => ({
      models: patchModelById(state.models, id, { placement, isPlaced: true }),
    })),

  persistModelPlacement: (id) => {
    const model = get().models.find((row) => row.id === id);
    if (!model) return;
    void upsertIfcRecord(toPersistRecord(model)).catch((error) => {
      console.error("Failed to persist IFC placement", error);
    });
  },

  requestGeometryReload: (id) =>
    set((state) => ({
      models: state.models.map((model) =>
        model.id === id
          ? {
              ...model,
              geometryStatus: "idle",
              geometryStats: undefined,
              geometryError: undefined,
              geometryRevision: model.geometryRevision + 1,
            }
          : model,
      ),
    })),

  clearModels: () => {
    set({ models: [], activeModelId: null });
    void clearIfcRecords().catch((error) => {
      console.error("Failed to clear IFC records", error);
    });
  },
}));
