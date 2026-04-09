"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { analyzeIfcFile } from "@/lib/ifc/analyzeIfcFile";
import { useIfcStore } from "@/store/ifcStore";
import type { IfcModelItem, IfcPlacement } from "@/types/ifc";

const MODEL_DND_MIME = "application/x-gravio-model-id";

const IfcViewport = dynamic(() => import("@/components/IfcViewport"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-950 text-sm text-slate-400">
      Initializing viewport...
    </div>
  ),
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function formatCoord(value: number): string {
  return value.toFixed(3);
}

function statusTone(model: IfcModelItem): string {
  if (model.analysisStatus === "error" || model.geometryStatus === "error") {
    return "text-red-300 bg-red-500/15 border-red-500/40";
  }
  if (model.analysisStatus === "ready" && model.geometryStatus === "ready") {
    return "text-emerald-300 bg-emerald-500/15 border-emerald-500/40";
  }
  if (model.analysisStatus === "analyzing" || model.geometryStatus === "loading") {
    return "text-amber-300 bg-amber-500/15 border-amber-500/40";
  }
  return "text-slate-300 bg-slate-500/15 border-slate-500/40";
}

export default function AppShell() {
  const [isDragging, setIsDragging] = useState(false);
  const [viewMode, setViewMode] = useState<"2d" | "3d">("3d");
  const [transformMode, setTransformMode] = useState<"translate" | "rotate">("translate");

  const {
    models,
    activeModelId,
    hydrationStatus,
    hydrateFromStorage,
    addFiles,
    removeModel,
    setActiveModelId,
    setAnalysisResult,
    setAnalysisError,
    setAnalysisStatus,
    setGeometryStatus,
    setGeometryResult,
    setGeometryError,
    setModelPlacement,
    persistModelPlacement,
    requestGeometryReload,
    spawnModelInstance,
    clearModels,
  } = useIfcStore();

  useEffect(() => {
    void hydrateFromStorage();
  }, [hydrateFromStorage]);

  const activeModel = useMemo(
    () => models.find((model) => model.id === activeModelId) ?? null,
    [activeModelId, models],
  );

  const analysisInFlight = useRef<Set<string>>(new Set());
  const canProcessQueue = hydrationStatus !== "loading";

  useEffect(() => {
    if (!canProcessQueue) return;
    const next = models.find((model) => model.analysisStatus === "queued");
    if (!next) return;
    if (analysisInFlight.current.has(next.id)) return;

    analysisInFlight.current.add(next.id);
    setAnalysisStatus(next.id, "analyzing");

    (async () => {
      try {
        const analysis = await analyzeIfcFile(next.file);
        setAnalysisResult(next.id, analysis);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to analyze IFC.";
        setAnalysisError(next.id, message);
      } finally {
        analysisInFlight.current.delete(next.id);
      }
    })();
  }, [canProcessQueue, models, setAnalysisError, setAnalysisResult, setAnalysisStatus]);

  const onPickFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      addFiles(Array.from(files));
    },
    [addFiles],
  );

  const readyCount = useMemo(
    () =>
      models.filter(
        (model) => model.analysisStatus === "ready" && model.geometryStatus === "ready",
      ).length,
    [models],
  );

  const handleGeometryLoading = useCallback(
    (id: string) => setGeometryStatus(id, "loading"),
    [setGeometryStatus],
  );

  const handleGeometryReady = useCallback(
    (id: string, stats: NonNullable<IfcModelItem["geometryStats"]>) => {
      setGeometryResult(id, stats);
    },
    [setGeometryResult],
  );

  const handleGeometryError = useCallback(
    (id: string, message: string) => setGeometryError(id, message),
    [setGeometryError],
  );

  const handlePlacementCommit = useCallback(
    (id: string, placement: IfcPlacement) => {
      setModelPlacement(id, placement);
      persistModelPlacement(id);
    },
    [persistModelPlacement, setModelPlacement],
  );

  const handleDropModel = useCallback(
    (id: string, placement: IfcPlacement) => {
      const instanceId = spawnModelInstance(id, placement);
      if (instanceId) persistModelPlacement(instanceId);
      return instanceId;
    },
    [persistModelPlacement, spawnModelInstance],
  );

  return (
    <div className="flex h-screen flex-col bg-slate-900 text-slate-100">
      <header className="flex h-12 items-center justify-between border-b border-slate-800 px-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-wide">gravio</span>
          <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
            Next 16 / React 19 / web-ifc
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <div className="flex items-center rounded border border-slate-700 bg-slate-800 p-0.5">
            <button
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                viewMode === "2d"
                  ? "bg-slate-600 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setViewMode("2d")}
            >
              2D
            </button>
            <button
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                viewMode === "3d"
                  ? "bg-slate-600 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setViewMode("3d")}
            >
              3D
            </button>
          </div>
          <div className="flex items-center rounded border border-slate-700 bg-slate-800 p-0.5">
            <button
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                transformMode === "translate"
                  ? "bg-slate-600 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setTransformMode("translate")}
            >
              Move
            </button>
            <button
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                transformMode === "rotate"
                  ? "bg-slate-600 text-slate-100"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              onClick={() => setTransformMode("rotate")}
            >
              Rotate
            </button>
          </div>
          {hydrationStatus === "loading" && <span>restoring...</span>}
          <span>{models.length} models</span>
          <span className="text-slate-600">|</span>
          <span>{readyCount} ready</span>
          <Button size="xs" variant="ghost" onClick={clearModels} disabled={models.length === 0}>
            Clear
          </Button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)_320px]">
        <section className="min-h-[260px] border-b border-slate-800 md:min-h-0 md:border-b-0 md:border-r">
          <div className="flex h-full flex-col">
            <div className="border-b border-slate-800 p-3">
              <label
                className={`flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 text-center transition-colors ${
                  isDragging
                    ? "border-cyan-400 bg-cyan-500/10 text-cyan-200"
                    : "border-slate-600 bg-slate-800/50 text-slate-300 hover:border-slate-400"
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  onPickFiles(event.dataTransfer.files);
                }}
              >
                <input
                  className="hidden"
                  type="file"
                  accept=".ifc"
                  multiple
                  onChange={(event) => {
                    onPickFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
                <span className="text-sm font-medium">Drop IFC files here</span>
                <span className="text-xs text-slate-400">or click to browse</span>
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {models.length === 0 && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-500">
                  Add one or more `.ifc` files to start analysis and geometry extraction.
                </div>
              )}

              <ul className="space-y-2">
                {models.map((model) => {
                  const isActive = model.id === activeModelId;
                  return (
                    <li key={model.id}>
                      <button
                        className={`w-full rounded-lg border p-2 text-left transition-colors ${
                          isActive
                            ? "border-cyan-400 bg-cyan-500/10"
                            : "border-slate-800 bg-slate-900/60 hover:border-slate-600"
                        }`}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(MODEL_DND_MIME, model.id);
                        }}
                        onClick={() => setActiveModelId(model.id)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-100">{model.name}</p>
                            <p className="text-xs text-slate-400">{formatBytes(model.size)}</p>
                          </div>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${statusTone(
                              model,
                            )}`}
                          >
                            {model.analysisStatus === "ready" && model.geometryStatus === "ready"
                              ? "ready"
                              : model.geometryStatus === "loading"
                                ? "building"
                                : model.analysisStatus}
                          </span>
                        </div>

                        <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                          <span>{model.analysis?.schema ?? "schema: n/a"}</span>
                          <span>
                            {model.analysis?.entityTotal
                              ? `${model.analysis.entityTotal.toLocaleString()} entities`
                              : "entities: n/a"}
                          </span>
                          <span>{model.isPlaced ? "on canvas" : "library"}</span>
                        </div>
                      </button>

                      <div className="mt-1 flex justify-end">
                        <button
                          className="px-1 text-[11px] text-slate-500 hover:text-red-300"
                          onClick={() => removeModel(model.id)}
                        >
                          remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>

        <section className="min-h-[320px] md:min-h-0">
          <IfcViewport
            models={models}
            activeModelId={activeModelId}
            viewMode={viewMode}
            transformMode={transformMode}
            onGeometryLoading={handleGeometryLoading}
            onGeometryReady={handleGeometryReady}
            onGeometryError={handleGeometryError}
            onPlacementCommit={handlePlacementCommit}
            onSelectModel={setActiveModelId}
            onDropModel={handleDropModel}
          />
        </section>

        <section className="min-h-[260px] border-t border-slate-800 md:min-h-0 md:border-l md:border-t-0">
          <div className="flex h-full flex-col">
            <div className="border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold">Model Inspector</h2>
              <p className="text-xs text-slate-400">Fast metadata + on-demand geometry pipeline</p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!activeModel && (
                <p className="text-sm text-slate-500">Select an IFC model from the library.</p>
              )}

              {activeModel && (
                <div className="space-y-4 text-sm">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">File</p>
                    <p className="mt-1 break-all text-slate-200">{activeModel.name}</p>
                    <p className="text-xs text-slate-400">{formatBytes(activeModel.size)}</p>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">Analysis</p>
                    <p className="mt-1 text-slate-300">Status: {activeModel.analysisStatus}</p>
                    {activeModel.analysis && (
                      <>
                        <p className="text-slate-300">Schema: {activeModel.analysis.schema}</p>
                        <p className="text-slate-300">
                          Entities: {activeModel.analysis.entityTotal.toLocaleString()}
                        </p>
                        <p className="text-slate-300">
                          Walls/Slabs: {activeModel.analysis.elementMetrics.walls}/
                          {activeModel.analysis.elementMetrics.slabs}
                        </p>
                        <p className="text-slate-300">
                          Doors/Windows: {activeModel.analysis.elementMetrics.doors}/
                          {activeModel.analysis.elementMetrics.windows}
                        </p>
                        <p className="text-slate-300">
                          Spaces: {activeModel.analysis.elementMetrics.spaces}
                        </p>
                        <p className="text-xs text-slate-400">
                          Time: {formatMs(activeModel.analysis.analysisMs)}
                        </p>
                      </>
                    )}
                    {activeModel.analysisError && (
                      <p className="mt-1 text-xs text-red-300">{activeModel.analysisError}</p>
                    )}
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">Site Placement</p>
                    <p className="mt-1 text-slate-300">
                      Position XYZ: {formatCoord(activeModel.placement.x)},{" "}
                      {formatCoord(activeModel.placement.y)}, {formatCoord(activeModel.placement.z)}
                    </p>
                    <p className="text-slate-300">
                      Rotation Y: {formatCoord((activeModel.placement.rotationY * 180) / Math.PI)}°
                    </p>
                  </div>

                  <div>
                    <p className="text-xs uppercase tracking-wider text-slate-500">Geometry</p>
                    <p className="mt-1 text-slate-300">Status: {activeModel.geometryStatus}</p>
                    {activeModel.geometryStats && (
                      <>
                        <p className="text-slate-300">
                          Meshes: {activeModel.geometryStats.meshes.toLocaleString()}
                        </p>
                        <p className="text-slate-300">
                          Vertices: {activeModel.geometryStats.vertices.toLocaleString()}
                        </p>
                        <p className="text-slate-300">
                          Triangles: {activeModel.geometryStats.triangles.toLocaleString()}
                        </p>
                        <p className="text-xs text-slate-400">
                          Build: {formatMs(activeModel.geometryStats.buildMs)}
                        </p>
                        <p className="pt-2 text-xs uppercase tracking-wider text-slate-500">Placement</p>
                        <p className="text-slate-300">
                          Mode: {activeModel.geometryStats.placement.mode}
                        </p>
                        <p className="text-slate-300">
                          Offset XYZ:{" "}
                          {formatCoord(activeModel.geometryStats.placement.offset.x)},{" "}
                          {formatCoord(activeModel.geometryStats.placement.offset.y)},{" "}
                          {formatCoord(activeModel.geometryStats.placement.offset.z)}
                        </p>
                        <p className="text-slate-400">
                          Rule: center X/Z to origin, min Y to ground (0)
                        </p>
                      </>
                    )}
                    {activeModel.geometryError && (
                      <p className="mt-1 text-xs text-red-300">{activeModel.geometryError}</p>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-800 p-3">
              <Button
                className="w-full"
                variant="outline"
                disabled={!activeModel || activeModel.analysisStatus !== "ready"}
                onClick={() => {
                  if (!activeModel) return;
                  requestGeometryReload(activeModel.id);
                }}
              >
                Rebuild Geometry
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
