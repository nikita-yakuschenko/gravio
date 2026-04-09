export type IfcAnalysisStatus = "queued" | "analyzing" | "ready" | "error";
export type IfcGeometryStatus = "idle" | "loading" | "ready" | "error";

export interface IfcPlacement {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

export interface IfcElementMetrics {
  walls: number;
  slabs: number;
  doors: number;
  windows: number;
  spaces: number;
}

export interface IfcAnalysis {
  schema: string;
  entityTotal: number;
  elementMetrics: IfcElementMetrics;
  analysisMs: number;
}

export interface IfcGeometryStats {
  meshes: number;
  triangles: number;
  vertices: number;
  buildMs: number;
  placement: {
    mode: "center-ground";
    offset: {
      x: number;
      y: number;
      z: number;
    };
    sourceBounds: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    };
  };
}

export interface IfcModelItem {
  id: string;
  file: File;
  name: string;
  size: number;
  addedAt: number;
  isPlaced: boolean;
  analysisStatus: IfcAnalysisStatus;
  analysis?: IfcAnalysis;
  analysisError?: string;
  geometryStatus: IfcGeometryStatus;
  geometryStats?: IfcGeometryStats;
  geometryError?: string;
  geometryRevision: number;
  placement: IfcPlacement;
}
