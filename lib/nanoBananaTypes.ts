import type { ArchitecturalModelDetail } from "@/lib/nanoBananaArchitecturalDetail";

export type NanoBananaCameraSnapshot = {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  quaternion: [number, number, number, number];
  fovDeg: number;
  aspect: number;
  near: number;
  far: number;
  zoom: number;
};

export type PlacedModelSnapshot = {
  id: string;
  name: string;
  placement: {
    x: number;
    y: number;
    z: number;
    rotationYRad: number;
    rotationYDeg: number;
  };
};

export type BuildNanoBananaPromptInput = {
  viewMode: "2d" | "3d";
  camera: NanoBananaCameraSnapshot | null;
  canvasCssWidth: number;
  canvasCssHeight: number;
  placedModels: PlacedModelSnapshot[];
  architecturalModels: ArchitecturalModelDetail[];
  error?: string;
};
