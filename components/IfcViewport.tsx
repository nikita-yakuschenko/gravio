"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Html, MapControls, OrbitControls, TransformControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { IfcModelItem } from "@/types/ifc";
import { loadIfcGeometry } from "@/lib/ifc/loadIfcGeometry";
import {
  buildNanoBananaPromptJson,
  collectPlacedModelSnapshots,
} from "@/lib/buildNanoBananaPrompt";
import { buildArchitecturalModelDetail } from "@/lib/nanoBananaArchitecturalDetail";
import { VIEWPORT_OUTDOOR_SPEC } from "@/lib/viewportOutdoorSpec";
import { CadastreParcelLayer } from "@/components/cadastre/CadastreParcelLayer";
import { CadastreViewportFocus } from "@/components/cadastre/CadastreViewportFocus";
import { useParcelBaseStore } from "@/store/parcelBaseStore";

interface Props {
  models: IfcModelItem[];
  activeModelId: string | null;
  workspaceMode?: "parcel" | "objects" | "masterplan";
  viewMode: "2d" | "3d";
  transformMode: "translate" | "rotate";
  /** Отладка: янтарные контуры следов, выноски HTML. */
  devMode: boolean;
  rotationSnapEnabled: boolean;
  rotationSnapStepDegrees: number;
  onGeometryLoading: (id: string) => void;
  onGeometryReady: (id: string, stats: NonNullable<IfcModelItem["geometryStats"]>) => void;
  onGeometryError: (id: string, message: string) => void;
  onPlacementCommit: (id: string, placement: IfcModelItem["placement"]) => void;
  onSelectModel: (id: string) => void;
  onDropModel: (id: string, placement: IfcModelItem["placement"]) => string | null;
}

interface CacheEntry {
  object: THREE.Group;
  stats: NonNullable<IfcModelItem["geometryStats"]>;
  bounds: ModelBounds;
}

interface ModelBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface GroundPoint {
  x: number;
  z: number;
}

interface ModelGroundFootprint {
  id: string;
  center: GroundPoint;
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  minY: number;
  maxY: number;
}

type AlignmentEdge = "left" | "right" | "top" | "bottom";

interface GroundSegment {
  start: GroundPoint;
  end: GroundPoint;
  edge: AlignmentEdge;
}

interface MeasurementLine {
  id: string;
  start: [number, number, number];
  end: [number, number, number];
  sourceCenter: [number, number, number];
  targetCenter: [number, number, number];
  label: [number, number, number];
  distance: number;
}

interface AlignmentPlaneHint {
  id: string;
  source: GroundSegment;
  target: GroundSegment;
  spanPoints: GroundPoint[];
  minY: number;
  maxY: number;
}

interface ProximityHatchArea {
  id: string;
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  hatchSegments: Array<[GroundPoint, GroundPoint]>;
  /** Рёбра следов, между которыми построена полоса (мир XZ). */
  source: GroundSegment;
  target: GroundSegment;
  /** Ближайшие точки на отрезках source/target и зазор (как размерная линия). */
  bridgeA: GroundPoint;
  bridgeB: GroundPoint;
  gapDistance: number;
  sourceModelId: string;
  targetModelId: string;
}

interface AlignmentSnapTarget {
  edge: AlignmentEdge;
  value: number;
}

interface AlignmentSnapData {
  activeOffsets: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  xTargets: AlignmentSnapTarget[];
  zTargets: AlignmentSnapTarget[];
}

type ViewportScale = {
  meters: number;
  pixels: number;
};

type TerrainPatch = {
  geometry: THREE.PlaneGeometry;
  size: number;
};

type DragState =
  | {
      type: "move";
      pointerId: number;
      offsetX: number;
      offsetZ: number;
    }
  | {
      type: "rotate";
      pointerId: number;
      centerX: number;
      centerZ: number;
      startAngle: number;
      startRotation: number;
    };

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const TERRAIN_WORLD_Y_OFFSET = VIEWPORT_OUTDOOR_SPEC.ground.planeY + 0.012;
const MODEL_TERRAIN_CLEARANCE_M = 0.065;

function mercatorToLonLat(x: number, y: number): { lat: number; lon: number } {
  const R = 6378137;
  const lon = (x / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
  return { lat, lon };
}

/** Светлое «день на улице»: небо, туман, трава; без перехвата raycast (как сетка). */
function OutdoorGroundEnvironment() {
  const grassRef = useRef<THREE.Mesh>(null);
  const gridRef = useRef<THREE.GridHelper>(null);
  const parcel = useParcelBaseStore((s) => s.parcel);
  const parcelRadius = parcel?.fitRadiusM ?? 0;
  const terrainProviderPref = useParcelBaseStore((s) => s.terrainProviderPref);
  const { camera, size } = useThree();
  const [gridVisual, setGridVisual] = useState<{ size: number; divisions: number }>({
    size: VIEWPORT_OUTDOOR_SPEC.grid.size,
    divisions: VIEWPORT_OUTDOOR_SPEC.grid.divisions,
  });
  const [terrainPatch, setTerrainPatch] = useState<TerrainPatch | null>(null);
  const setTerrainStatus = useParcelBaseStore((s) => s.setTerrainStatus);
  const setTerrainField = useParcelBaseStore((s) => s.setTerrainField);

  const frameTickRef = useRef(0);
  const lastGridKeyRef = useRef("");
  const gridRayRef = useRef(new THREE.Raycaster());
  const gridLeftRef = useRef(new THREE.Vector3());
  const gridRightRef = useRef(new THREE.Vector3());

  useLayoutEffect(() => {
    const m = grassRef.current;
    if (!m) return;
    m.raycast = () => {};
  }, []);

  useEffect(() => {
    const g = gridRef.current;
    if (!g) return;
    const mats = Array.isArray(g.material) ? g.material : [g.material];
    for (const mat of mats) {
      mat.transparent = true;
      mat.opacity = 0.42;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  }, [gridVisual]);

  useEffect(() => {
    return () => {
      setTerrainPatch((old) => {
        old?.geometry.dispose();
        return null;
      });
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!parcel || !parcel.center3857 || parcel.fitRadiusM < 20) {
      setTerrainPatch((old) => {
        old?.geometry.dispose();
        return null;
      });
      setTerrainField(null);
      setTerrainStatus("idle", null, null);
      return;
    }
    setTerrainStatus("loading", "Запрашиваем высоты...", null);

    const buildTerrain = async () => {
      const n = 9; // 81 точка, укладываемся в лимит 100/запрос.
      const sizeM = Math.max(parcel.fitRadiusM * 2.4, 180);
      const half = sizeM / 2;
      const locations: string[] = [];
      const sampleCount = n * n;

      for (let j = 0; j < n; j++) {
        const tz = j / (n - 1);
        const worldZ = -half + tz * sizeM;
        for (let i = 0; i < n; i++) {
          const tx = i / (n - 1);
          const worldX = -half + tx * sizeM;
          const mx = parcel.center3857.x + worldX;
          const my = parcel.center3857.y - worldZ;
          const { lat, lon } = mercatorToLonLat(mx, my);
          locations.push(`${lat.toFixed(6)},${lon.toFixed(6)}`);
        }
      }

      try {
        const res = await fetch("/api/terrain/elevation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "srtm30m", locations, provider: terrainProviderPref }),
          cache: "no-store",
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
          throw new Error(err.detail ? `${err.error ?? "OpenTopoData error"}: ${err.detail}` : (err.error ?? `OpenTopoData ${res.status}`));
        }
        const json = (await res.json()) as {
          provider?: string;
          results?: Array<{ elevation: number | null }>;
        };
        const values = (json.results ?? []).map((r) =>
          typeof r.elevation === "number" && Number.isFinite(r.elevation) ? r.elevation : NaN,
        );
        if (values.length !== sampleCount) throw new Error("Invalid elevation samples");
        const finite = values.filter((v) => Number.isFinite(v));
        if (finite.length < 8) throw new Error("Too few finite elevations");
        finite.sort((a, b) => a - b);
        const median = finite[Math.floor(finite.length / 2)]!;
        const minElev = finite[0]!;
        const maxElev = finite[finite.length - 1]!;
        const rawRange = Math.max(maxElev - minElev, 0.1);
        // Авто-экзагерация: на «плоских» участках усиливаем рельеф для читаемости.
        const exaggeration = THREE.MathUtils.clamp(12 / rawRange, 1, 26);
        if (cancelled) return;

        const geom = new THREE.PlaneGeometry(sizeM, sizeM, n - 1, n - 1);
        geom.rotateX(-Math.PI / 2);
        const pos = geom.attributes.position;
        const colorAttr = new Float32Array(sampleCount * 3);
        const relHeights = new Array<number>(sampleCount);
        let minY = Infinity;
        let maxY = -Infinity;
        for (let idx = 0; idx < sampleCount; idx++) {
          const rel = (Number.isFinite(values[idx]!) ? values[idx]! - median : 0) * exaggeration;
          relHeights[idx] = rel;
          minY = Math.min(minY, rel);
          maxY = Math.max(maxY, rel);
        }
        // Вся поверхность должна быть выше нулевой плоскости, иначе часть рельефа скрывается под "землей".
        const baseLift = -Math.min(minY, 0) + 0.06;
        minY = Infinity;
        maxY = -Infinity;
        for (let idx = 0; idx < sampleCount; idx++) {
          const y = relHeights[idx]! + baseLift;
          pos.setY(idx, y);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        pos.needsUpdate = true;
        const spanY = Math.max(maxY - minY, 0.0001);
        const low = new THREE.Color("#5f7d52");
        const high = new THREE.Color("#bcd3a4");
        const c = new THREE.Color();
        for (let idx = 0; idx < sampleCount; idx++) {
          const y = pos.getY(idx);
          const t = THREE.MathUtils.clamp((y - minY) / spanY, 0, 1);
          c.copy(low).lerp(high, t);
          colorAttr[idx * 3] = c.r;
          colorAttr[idx * 3 + 1] = c.g;
          colorAttr[idx * 3 + 2] = c.b;
        }
        geom.setAttribute("color", new THREE.Float32BufferAttribute(colorAttr, 3));
        geom.computeVertexNormals();

        setTerrainPatch((old) => {
          old?.geometry.dispose();
          return { geometry: geom, size: sizeM };
        });
        setTerrainField({
          size: sizeM,
          resolution: n,
          heights: Array.from({ length: sampleCount }, (_, idx) => pos.getY(idx)),
        });
        setTerrainStatus(
          "ready",
          `Рельеф: ${sampleCount} т., перепад ~${rawRange.toFixed(1)} м, x${exaggeration.toFixed(1)}, подъём +${baseLift.toFixed(2)} м`,
          (json.provider as "open-elevation" | "opentopodata" | undefined) ?? "unknown",
        );
      } catch (e) {
        if (cancelled) return;
        setTerrainPatch((old) => {
          old?.geometry.dispose();
          return null;
        });
        setTerrainField(null);
        const msg = e instanceof Error ? e.message : "OpenTopoData error";
        setTerrainStatus("error", `Рельеф не загружен: ${msg}`, null);
      }
    };

    void buildTerrain();
    return () => {
      cancelled = true;
    };
  }, [parcel?.loadedAt, parcel?.fitRadiusM, parcel?.center3857?.x, parcel?.center3857?.y, terrainProviderPref]);

  useFrame(() => {
    frameTickRef.current += 1;
    if (frameTickRef.current % 8 !== 0) return;

    const cam = camera as THREE.PerspectiveCamera;
    const width = size.width;
    const height = size.height;
    if (width < 40 || height < 40) return;

    // Реальный «метр на пиксель» внизу экрана: стабильно реагирует на zoom in/out.
    const samplePx = 140;
    const yPx = Math.max(20, height - 36);
    const xRight = Math.max(samplePx + 30, width - 26);
    const xLeft = xRight - samplePx;
    const ray = gridRayRef.current;
    const ndcL = new THREE.Vector2((xLeft / width) * 2 - 1, -(yPx / height) * 2 + 1);
    const ndcR = new THREE.Vector2((xRight / width) * 2 - 1, -(yPx / height) * 2 + 1);
    ray.setFromCamera(ndcL, cam);
    const hitL = ray.ray.intersectPlane(GROUND_PLANE, gridLeftRef.current);
    ray.setFromCamera(ndcR, cam);
    const hitR = ray.ray.intersectPlane(GROUND_PLANE, gridRightRef.current);
    if (!hitL || !hitR) return;
    const metersPerPx = gridLeftRef.current.distanceTo(gridRightRef.current) / samplePx;
    if (!Number.isFinite(metersPerPx) || metersPerPx <= 0) return;

    const dist = cam.position.length();
    const base = Math.max(VIEWPORT_OUTDOOR_SPEC.grid.size, parcelRadius * 2.6);
    const zoomFactor = THREE.MathUtils.clamp(dist / 300, 0.65, 2.4);
    const nextSize = Math.max(220, base * zoomFactor);
    // При zoom out metersPerPx растет => шаг клетки крупнее => сетка реже.
    const targetCellSize = THREE.MathUtils.clamp(metersPerPx * 42, 10, 520);
    const nextDiv = Math.max(4, Math.min(100, Math.round(nextSize / targetCellSize)));
    const key = `${Math.round(nextSize)}:${nextDiv}`;
    if (lastGridKeyRef.current !== key) {
      lastGridKeyRef.current = key;
      setGridVisual({ size: nextSize, divisions: nextDiv });
    }
  });

  const s = VIEWPORT_OUTDOOR_SPEC;
  // Подстраиваем окружение под крупные участки, чтобы сетка и земля оставались читаемыми.
  const gridSize = gridVisual.size;
  // Зеленое поле всегда шире сетки, чтобы не было «сетки за пределами поля».
  const groundSize = Math.max(
    s.ground.planeSize,
    parcelRadius * 3.2,
    gridSize * 1.12,
    (terrainPatch?.size ?? 0) * 1.06,
  );
  const gridDivisions = gridVisual.divisions;
  return (
    <>
      <color attach="background" args={[s.backgroundHex]} />
      <hemisphereLight args={[s.hemisphere.skyHex, s.hemisphere.groundHex, s.hemisphere.intensity]} />
      <ambientLight intensity={s.ambient.intensity} color={s.ambient.colorHex} />
      <directionalLight
        position={[...s.directionalWarm.position]}
        intensity={s.directionalWarm.intensity}
        color={s.directionalWarm.colorHex}
      />
      <directionalLight
        position={[...s.directionalCool.position]}
        intensity={s.directionalCool.intensity}
        color={s.directionalCool.colorHex}
      />
      <mesh
        ref={grassRef}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, s.ground.planeY, 0]}
        frustumCulled={false}
      >
        <planeGeometry args={[groundSize, groundSize]} />
        <meshStandardMaterial
          color={s.ground.grassColorHex}
          roughness={s.ground.roughness}
          metalness={s.ground.metalness}
          envMapIntensity={0.35}
        />
      </mesh>
      {terrainPatch ? (
        <mesh position={[0, s.ground.planeY + 0.012, 0]} geometry={terrainPatch.geometry} frustumCulled={false}>
          <meshStandardMaterial
            vertexColors
            roughness={0.92}
            metalness={0.02}
            transparent
            opacity={0.96}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>
      ) : null}
      <gridHelper
        ref={gridRef}
        args={[gridSize, gridDivisions, s.grid.colorCenter, s.grid.colorGrid]}
        position={[0, s.grid.y, 0]}
      />
    </>
  );
}

/** Позиция камеры + target Orbit/MapControls для 2D/3D после перезагрузки. */
const VIEWPORT_CAMERA_STORAGE_KEY = "gravio-viewport-camera-v1";

type StoredViewportCamera = {
  position: [number, number, number];
  target: [number, number, number];
};

function parseStoredViewportCameras(): Partial<Record<"2d" | "3d", StoredViewportCamera>> {
  try {
    const raw = localStorage.getItem(VIEWPORT_CAMERA_STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return {};
    return data as Partial<Record<"2d" | "3d", StoredViewportCamera>>;
  } catch {
    return {};
  }
}

function isValidStoredViewportCamera(v: unknown): v is StoredViewportCamera {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.position) || o.position.length !== 3) return false;
  if (!Array.isArray(o.target) || o.target.length !== 3) return false;
  const nums = [...o.position, ...o.target];
  return nums.every((n) => typeof n === "number" && Number.isFinite(n));
}

function persistViewportCamera(
  viewMode: "2d" | "3d",
  position: THREE.Vector3,
  target: THREE.Vector3,
) {
  try {
    const data = parseStoredViewportCameras();
    data[viewMode] = {
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
    };
    localStorage.setItem(VIEWPORT_CAMERA_STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore quota / private mode */
  }
}

function pickNiceDistance(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  const n = value / power;
  if (n < 1.5) return 1 * power;
  if (n < 3.5) return 2 * power;
  if (n < 7.5) return 5 * power;
  return 10 * power;
}

function formatScaleDistance(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000;
    return `${km.toFixed(km >= 10 ? 0 : 1)} км`;
  }
  return `${Math.round(meters)} м`;
}

function ViewportScaleProbe({
  onScaleChange,
}: {
  onScaleChange: (scale: ViewportScale | null) => void;
}) {
  const { camera, size } = useThree();
  const raycasterRef = useRef(new THREE.Raycaster());
  const leftRef = useRef(new THREE.Vector3());
  const rightRef = useRef(new THREE.Vector3());
  const lastKeyRef = useRef<string>("");
  const frameCountRef = useRef(0);

  useFrame(() => {
    frameCountRef.current += 1;
    if (frameCountRef.current % 4 !== 0) return;
    const width = size.width;
    const height = size.height;
    if (width < 40 || height < 40) return;

    const samplePx = 120;
    const marginRight = 28;
    const yPx = Math.max(20, height - 34);
    const xRight = Math.max(marginRight + samplePx + 4, width - marginRight);
    const xLeft = xRight - samplePx;

    const ray = raycasterRef.current;
    const ndcL = new THREE.Vector2((xLeft / width) * 2 - 1, -(yPx / height) * 2 + 1);
    const ndcR = new THREE.Vector2((xRight / width) * 2 - 1, -(yPx / height) * 2 + 1);
    ray.setFromCamera(ndcL, camera);
    const hitL = ray.ray.intersectPlane(GROUND_PLANE, leftRef.current);
    ray.setFromCamera(ndcR, camera);
    const hitR = ray.ray.intersectPlane(GROUND_PLANE, rightRef.current);
    if (!hitL || !hitR) {
      if (lastKeyRef.current !== "none") {
        lastKeyRef.current = "none";
        onScaleChange(null);
      }
      return;
    }

    const worldDist = leftRef.current.distanceTo(rightRef.current);
    if (!Number.isFinite(worldDist) || worldDist <= 0.0001) return;
    const niceMeters = pickNiceDistance(worldDist);
    if (niceMeters <= 0) return;
    const pixels = (samplePx * niceMeters) / worldDist;
    const boundedPixels = Math.max(40, Math.min(180, pixels));
    const key = `${Math.round(niceMeters)}:${Math.round(boundedPixels)}`;
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      onScaleChange({ meters: niceMeters, pixels: boundedPixels });
    }
  });

  return null;
}

const MODEL_DND_MIME = "application/x-gravio-model-id";
const ZERO_PLACEMENT: IfcModelItem["placement"] = { x: 0, y: 0, z: 0, rotationY: 0 };
const MOVE_DRAG_SENSITIVITY = 0.24;
const MOVE_DRAG_MAX_STEP = 0.45;
const MOVE_DRAG_DEAD_ZONE = 0.003;
const ROTATE_DRAG_SENSITIVITY = 1;
const ROTATE_DRAG_DEAD_ZONE = THREE.MathUtils.degToRad(0.08);
/** Общий порог «параллельности» двух рёбер следа (рад) — магнит граней, зона близости, подсветка при rotate. */
const PARALLEL_EDGE_TOLERANCE = THREE.MathUtils.degToRad(0.75);
/** Зона близости только при том же угловом допуске, что и магнит параллельных граней (не путать с 3° — визуально «не параллельно»). */
const PROXIMITY_HATCH_EDGE_TOLERANCE = PARALLEL_EDGE_TOLERANCE;
/** При вращении: краткое «прилипание» к параллели рёбер следа (может быть чуть шире визуального порога). */
const ROTATE_PARALLEL_EDGE_MAGNET_RAD = THREE.MathUtils.degToRad(3.2);
/** Розовая подсветка рёбер в режиме rotate — совпадает по смыслу с зоной близости (иначе «параллельно» при ~6° вводило в заблуждение). */
const ROTATE_PARALLEL_EDGE_HIGHLIGHT_RAD = PARALLEL_EDGE_TOLERANCE;
const ROTATE_PARALLEL_EDGE_LINE_Y = 0.1;
const ALIGNMENT_SNAP_DISTANCE = 0.35;
const EDGE_ALIGNMENT_TOLERANCE = 0.03;
/** Зона по нормали к параллельным рёбрам: подтягиваем активную модель к общей грани (магнит). */
const PARALLEL_FACE_MAGNET_DISTANCE = 0.14;
const ALIGNMENT_PLANE_COLOR = "#ec4899";
const PROXIMITY_HATCH_DISTANCE = 6;
const PROXIMITY_HATCH_STEP = 0.35;
const PROXIMITY_HATCH_COLOR = "#ec4899";
const PROXIMITY_EDGE_HIGHLIGHT_Y = 0.12;
const PROXIMITY_EDGE_HIGHLIGHT_COLOR = "#38bdf8";
/** Допуск: угол зоны на границе следа (м). */
const PROXIMITY_CORNER_ON_EDGE_EPS_M = 0.025;
/** Временно: штриховка близости видна всегда (не только во время переноса/вращения). Поставьте false — вернётся старое поведение. */
const PROXIMITY_HATCH_ALWAYS_ON = true;
const SELECTION_ACCENT_COLOR = "#0173F7";
/** Янтарный контур AABB по граням модели — для всех размещённых экземпляров (отладка / ориентир). */
const ALL_MODELS_BOUNDS_OUTLINE_COLOR = "#f59e0b";
/** Вбок в XZ перпендикулярно «объект→камера» (м) — крупное, чтобы панель не лезла на меш. */
const DEBUG_CALLOUT_SIDE_OFFSET_METERS = 11;
/** Дополнительно «наружу» от центра кластера моделей на земле (м). */
const DEBUG_CALLOUT_RADIAL_PUSH_M = 12;
/** Чуть к камере в XZ (м): выносит подпись в «передний план» относительно сцены. */
const DEBUG_CALLOUT_TOWARD_CAMERA_M = 5;
const DEBUG_CALLOUT_EXTRA_UP_METERS = 2.2;

function fmt3(n: number) {
  return Number.isFinite(n) ? n.toFixed(3) : "—";
}

function shortIdLabel(id: string) {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function debugCalloutSideSign(id: string): number {
  let s = 0;
  for (let i = 0; i < id.length; i += 1) s += id.charCodeAt(i);
  return s % 2 === 0 ? 1 : -1;
}

/** Ручной сдвиг выноски в пикселях экрана (внутри Html). */
function DraggableCalloutChrome({
  dragId,
  pixelOffset,
  onPixelDragDelta,
  children,
}: {
  dragId: string;
  pixelOffset: { x: number; y: number };
  onPixelDragDelta: (id: string, dx: number, dy: number) => void;
  children: React.ReactNode;
}) {
  const draggingRef = useRef(false);
  return (
    <div
      style={{
        transform: `translate(${pixelOffset.x}px, ${pixelOffset.y}px)`,
        touchAction: "none",
        pointerEvents: "auto",
      }}
    >
      <div
        className="mb-2 flex cursor-grab touch-none select-none items-center gap-2 rounded border border-slate-600/80 bg-slate-800/95 px-2 py-1 text-[11px] text-slate-300 active:cursor-grabbing"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          draggingRef.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          onPixelDragDelta(dragId, e.movementX, e.movementY);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }}
        onPointerCancel={(e) => {
          draggingRef.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }}
      >
        <span className="text-slate-500">⋮⋮</span>
        Перетащить выноску
      </div>
      {children}
    </div>
  );
}

type DebugCalloutVariant = "model" | "proximity";

const debugCalloutVariantStyle: Record<
  DebugCalloutVariant,
  { shell: string; heading: string; sep: string }
> = {
  model: {
    shell: "border-amber-500/50",
    heading: "text-amber-300",
    sep: "border-amber-600/40",
  },
  proximity: {
    shell: "border-fuchsia-500/55",
    heading: "text-fuchsia-300",
    sep: "border-fuchsia-700/45",
  },
};

const CALLOUT_MONO = "font-mono text-[12px] leading-snug text-slate-100";
const CALLOUT_HEADING = "text-[13px] font-bold tracking-tight";
const CALLOUT_SECTION = "mt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400";
const CALLOUT_LINE = "text-[12px] text-slate-200";
const CALLOUT_MUTED = "text-[11px] text-slate-500";
const CALLOUT_BTN =
  "rounded border border-slate-600/80 bg-slate-800/90 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700";

function DebugCalloutPanel({
  variant,
  heading,
  brief,
  detail,
  copyText,
}: {
  variant: DebugCalloutVariant;
  heading: ReactNode;
  brief: ReactNode;
  detail: ReactNode;
  copyText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const vs = debugCalloutVariantStyle[variant];
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      /* ignore */
    }
  }, [copyText]);
  return (
    <div
      className={`max-w-[min(520px,92vw)] rounded-md border-2 ${vs.shell} bg-slate-950/94 px-3 py-2.5 shadow-2xl backdrop-blur-sm ${CALLOUT_MONO}`}
    >
      <div className={`flex flex-wrap items-start justify-between gap-2 border-b ${vs.sep} pb-2`}>
        <div className={`min-w-0 flex-1 ${CALLOUT_HEADING} ${vs.heading}`}>{heading}</div>
        <div className="flex shrink-0 flex-col items-stretch gap-1 sm:flex-row sm:items-center">
          <button type="button" className={CALLOUT_BTN} onClick={() => void handleCopy()}>
            Копировать
          </button>
          <button type="button" className={CALLOUT_BTN} onClick={() => setExpanded((x) => !x)}>
            {expanded ? "Свернуть" : "Полностью"}
          </button>
        </div>
      </div>
      <div className="mt-2">{brief}</div>
      {expanded ? <div className={`mt-3 border-t ${vs.sep} pt-2`}>{detail}</div> : null}
    </div>
  );
}

/** Якорь: наружа от центра сцены + вбок от вида + легкий сдвиг к камере — подпись не на моделях. */
function DebugCalloutAnchor({
  base,
  sideSign,
  radialOrigin,
  children,
}: {
  base: [number, number, number];
  sideSign: number;
  /** Центр кластера моделей (XZ); от него толкаем подпись «наружу». */
  radialOrigin: { x: number; z: number } | null;
  children: React.ReactNode;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const baseRef = useRef(base);
  baseRef.current = base;
  const radialRef = useRef(radialOrigin);
  radialRef.current = radialOrigin;
  const { camera } = useThree();
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    let bx = baseRef.current[0];
    let by = baseRef.current[1];
    let bz = baseRef.current[2];

    const ro = radialRef.current;
    if (ro) {
      let rx = bx - ro.x;
      let rz = bz - ro.z;
      let rlen = Math.hypot(rx, rz);
      if (rlen < 0.35) {
        rx = camera.position.x - bx;
        rz = camera.position.z - bz;
        rlen = Math.hypot(rx, rz);
        if (rlen < 1e-8) {
          rx = 1;
          rz = 0;
          rlen = 1;
        }
      }
      rx /= rlen;
      rz /= rlen;
      bx += rx * DEBUG_CALLOUT_RADIAL_PUSH_M;
      bz += rz * DEBUG_CALLOUT_RADIAL_PUSH_M;
    }

    let vx = camera.position.x - bx;
    let vz = camera.position.z - bz;
    let flat = Math.hypot(vx, vz);
    if (flat < 1e-8) {
      vx = 1;
      vz = 0;
      flat = 1;
    } else {
      vx /= flat;
      vz /= flat;
    }
    if (DEBUG_CALLOUT_TOWARD_CAMERA_M > 0) {
      bx += vx * DEBUG_CALLOUT_TOWARD_CAMERA_M;
      bz += vz * DEBUG_CALLOUT_TOWARD_CAMERA_M;
    }
    const px = -vz * DEBUG_CALLOUT_SIDE_OFFSET_METERS * sideSign;
    const pz = vx * DEBUG_CALLOUT_SIDE_OFFSET_METERS * sideSign;
    g.position.set(bx + px, by + DEBUG_CALLOUT_EXTRA_UP_METERS, bz + pz);
  });
  return <group ref={groupRef}>{children}</group>;
}

function ModelDebugCallout({
  model,
  bounds,
  object,
  placement,
  radialOrigin,
  pixelOffset,
  onPixelDragDelta,
}: {
  model: IfcModelItem;
  bounds: ModelBounds;
  object: THREE.Object3D;
  placement: IfcModelItem["placement"];
  radialOrigin: { x: number; z: number } | null;
  pixelOffset: { x: number; y: number };
  onPixelDragDelta: (id: string, dx: number, dy: number) => void;
}) {
  const ox = object.position.x;
  const oy = object.position.y;
  const oz = object.position.z;
  const cx = ox + (bounds.minX + bounds.maxX) * 0.5;
  const cy = oy + bounds.maxY + 0.35;
  const cz = oz + (bounds.minZ + bounds.maxZ) * 0.5;
  const stats = model.geometryStats;
  const rotDeg = THREE.MathUtils.radToDeg(placement.rotationY);

  const copyText = useMemo(() => {
    const lines: string[] = [
      "Тип: IFC-модель",
      `ID: ${model.id}`,
      "",
      "САЙТ (placement)",
      `pos: ${fmt3(placement.x)}, ${fmt3(placement.y)}, ${fmt3(placement.z)}`,
      `rotY: ${fmt3(rotDeg)}°`,
      "",
      "IFC (center-ground)",
    ];
    if (stats) {
      lines.push(
        `offset: ${fmt3(stats.placement.offset.x)}, ${fmt3(stats.placement.offset.y)}, ${fmt3(stats.placement.offset.z)}`,
      );
      lines.push(
        `src min Y: ${fmt3(stats.placement.sourceBounds.min.y)} … max: ${fmt3(stats.placement.sourceBounds.max.y)}`,
      );
    } else {
      lines.push("stats: —");
    }
    lines.push(`group.pos: ${fmt3(ox)}, ${fmt3(oy)}, ${fmt3(oz)}`);
    lines.push("");
    lines.push("AABB (лок. корня IFC)");
    lines.push(`minY…maxY: ${fmt3(bounds.minY)} … ${fmt3(bounds.maxY)}`);
    lines.push(
      `XZ: [${fmt3(bounds.minX)}, ${fmt3(bounds.minZ)}] — [${fmt3(bounds.maxX)}, ${fmt3(bounds.maxZ)}]`,
    );
    if (stats) {
      lines.push("");
      lines.push(
        `ГЕОМ: ${stats.meshes} m · ${stats.vertices} v · ${stats.triangles} tri · ${fmt3(stats.buildMs)} ms`,
      );
    }
    return lines.join("\n");
  }, [bounds, model.id, ox, oy, oz, placement, rotDeg, stats]);

  const brief = (
    <div className="space-y-1">
      <div className={CALLOUT_LINE}>
        pos: {fmt3(placement.x)}, {fmt3(placement.y)}, {fmt3(placement.z)} · rotY {fmt3(rotDeg)}°
      </div>
      <div className={CALLOUT_MUTED}>
        AABB Y: {fmt3(bounds.minY)} … {fmt3(bounds.maxY)} · XZ [{fmt3(bounds.minX)}, {fmt3(bounds.minZ)}] — [
        {fmt3(bounds.maxX)}, {fmt3(bounds.maxZ)}]
      </div>
    </div>
  );

  const detail = (
    <div>
      <div className={CALLOUT_SECTION}>САЙТ (placement)</div>
      <div className={CALLOUT_LINE}>
        pos: {fmt3(placement.x)}, {fmt3(placement.y)}, {fmt3(placement.z)}
      </div>
      <div className={CALLOUT_LINE}>rotY: {fmt3(rotDeg)}°</div>
      <div className={CALLOUT_SECTION}>IFC (center-ground)</div>
      {stats ? (
        <>
          <div className={CALLOUT_LINE}>
            offset: {fmt3(stats.placement.offset.x)}, {fmt3(stats.placement.offset.y)},{" "}
            {fmt3(stats.placement.offset.z)}
          </div>
          <div className={CALLOUT_MUTED}>
            src min: {fmt3(stats.placement.sourceBounds.min.y)} … max:{" "}
            {fmt3(stats.placement.sourceBounds.max.y)} (Y)
          </div>
        </>
      ) : (
        <div className={CALLOUT_MUTED}>stats: —</div>
      )}
      <div className={CALLOUT_LINE}>
        group.pos: {fmt3(ox)}, {fmt3(oy)}, {fmt3(oz)}
      </div>
      <div className={CALLOUT_SECTION}>AABB (лок. корня IFC)</div>
      <div className={CALLOUT_LINE}>
        minY…maxY: {fmt3(bounds.minY)} … {fmt3(bounds.maxY)}
      </div>
      <div className={CALLOUT_LINE}>
        XZ: [{fmt3(bounds.minX)}, {fmt3(bounds.minZ)}] — [{fmt3(bounds.maxX)}, {fmt3(bounds.maxZ)}]
      </div>
      {stats ? (
        <div className={`${CALLOUT_SECTION} mt-2`}>
          ГЕОМ: {stats.meshes} m · {stats.vertices} v · {stats.triangles} tri · {fmt3(stats.buildMs)} ms
        </div>
      ) : null}
    </div>
  );

  return (
    <DebugCalloutAnchor
      base={[cx, cy, cz]}
      sideSign={debugCalloutSideSign(model.id)}
      radialOrigin={radialOrigin}
    >
      <Billboard follow>
        <Html
          center
          occlude={false}
          style={{ pointerEvents: "auto", userSelect: "none", width: "max-content" }}
        >
          <DraggableCalloutChrome
            dragId={model.id}
            pixelOffset={pixelOffset}
            onPixelDragDelta={onPixelDragDelta}
          >
            <DebugCalloutPanel
              variant="model"
              heading={shortIdLabel(model.id)}
              brief={brief}
              detail={detail}
              copyText={copyText}
            />
          </DraggableCalloutChrome>
        </Html>
      </Billboard>
    </DebugCalloutAnchor>
  );
}

function ProximityHatchDebugLabel({
  area,
  footprints,
  radialOrigin,
  pixelOffset,
  onPixelDragDelta,
  onHoverCornerSegment,
}: {
  area: ProximityHatchArea;
  footprints: ModelGroundFootprint[];
  radialOrigin: { x: number; z: number } | null;
  pixelOffset: { x: number; y: number };
  onPixelDragDelta: (id: string, dx: number, dy: number) => void;
  /** A,B → ребро source; C,D → target; подсветка на сцене. */
  onHoverCornerSegment: (corner: "A" | "B" | "C" | "D" | null) => void;
}) {
  const labelPos = useMemo((): [number, number, number] => {
    const [a, b, c, d] = area.corners;
    const x = (a.x + b.x + c.x + d.x) * 0.25;
    const z = (a.z + b.z + c.z + d.z) * 0.25;
    return [x, 0.2, z];
  }, [area.corners]);

  const parsed = useMemo(() => {
    const p = area.id.split(":");
    if (p.length >= 5 && p[4] === "hatch") {
      return { active: p[0], other: p[1], srcEdge: p[2], tgtEdge: p[3] };
    }
    return null;
  }, [area.id]);

  const fpActive = useMemo(() => {
    if (!parsed) return undefined;
    return footprints.find((f) => f.id === parsed.active);
  }, [footprints, parsed]);

  const fpOther = useMemo(() => {
    if (!parsed) return undefined;
    return footprints.find((f) => f.id === parsed.other);
  }, [footprints, parsed]);

  const cornerChecks = useMemo(() => {
    const labels = ["A", "B", "C", "D"] as const;
    return area.corners.map((p, i) => {
      const onChosenEdge = i < 2 ? area.source : area.target;
      const role = i < 2 ? ("source" as const) : ("target" as const);
      const chk = groundPointOnSegment(p, onChosenEdge);
      const minA = fpActive ? minDistanceToFootprintEdges(p, fpActive.corners) : null;
      const minO = fpOther ? minDistanceToFootprintEdges(p, fpOther.corners) : null;
      return { name: labels[i], p, role, edge: onChosenEdge.edge, chk, minA, minO };
    });
  }, [area.corners, area.source, area.target, fpActive, fpOther]);

  const spans = useMemo(() => {
    const [a, b, c, d] = area.corners;
    return [
      Math.hypot(b.x - a.x, b.z - a.z),
      Math.hypot(c.x - b.x, c.z - b.z),
      Math.hypot(d.x - c.x, d.z - c.z),
      Math.hypot(a.x - d.x, a.z - d.z),
    ];
  }, [area.corners]);

  const copyText = useMemo(() => {
    const lines: string[] = [
      "Тип: зона близости",
      `ID: ${area.id}`,
      "",
      `Зазор (мост): ${fmt3(area.gapDistance)} м`,
    ];
    if (parsed) {
      lines.push(`${shortIdLabel(parsed.active)} → ${shortIdLabel(parsed.other)}`);
      lines.push(`рёбра: ${parsed.srcEdge} / ${parsed.tgtEdge}`);
    }
    lines.push(`стороны: ${spans.map((s) => fmt3(s)).join(" · ")} м`);
    lines.push(
      `центр якоря: ${fmt3(labelPos[0])}, ${fmt3(labelPos[1])}, ${fmt3(labelPos[2])}`,
    );
    lines.push("");
    lines.push("Углы (мир, X Z) и отрезок границы");
    lines.push(`Допуск «на отрезке»: ${fmt3(PROXIMITY_CORNER_ON_EDGE_EPS_M)} м`);
    for (const row of cornerChecks) {
      const seg =
        row.chk.len > 1e-6
          ? `d⊥=${fmt3(row.chk.perp)} т=${fmt3(row.chk.along)}/${fmt3(row.chk.len)}`
          : `d⊥=${fmt3(row.chk.perp)}`;
      lines.push(
        `${row.name} (${fmt3(row.p.x)}, ${fmt3(row.p.z)}) ребро ${row.role} [${row.edge}]: ${row.chk.on ? "на отрезке" : "вне"} ${seg}`,
      );
      lines.push(
        `  min до контура active: ${row.minA !== null ? fmt3(row.minA) : "—"} · other: ${row.minO !== null ? fmt3(row.minO) : "—"}`,
      );
    }
    return lines.join("\n");
  }, [area.gapDistance, area.id, cornerChecks, labelPos, parsed, spans]);

  const brief = (
    <div className="space-y-1">
      <div className={`${CALLOUT_LINE} break-all`} title={area.id}>
        {parsed ? (
          <>
            {shortIdLabel(parsed.active)} → {shortIdLabel(parsed.other)}
            <span className={CALLOUT_MUTED}>
              {" "}
              · рёбра {parsed.srcEdge}/{parsed.tgtEdge}
            </span>
          </>
        ) : (
          <span className={CALLOUT_MUTED}>id без разбора</span>
        )}
      </div>
      <div className={CALLOUT_LINE}>зазор: {fmt3(area.gapDistance)} м</div>
      <div className={CALLOUT_MUTED}>стороны: {spans.map((s) => fmt3(s)).join(" · ")} м</div>
    </div>
  );

  const detail = (
    <div
      onPointerLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) {
          onHoverCornerSegment(null);
        }
      }}
    >
      <div className={CALLOUT_SECTION}>Идентификатор</div>
      <div className={`${CALLOUT_LINE} break-all`}>{area.id}</div>
      {parsed ? (
        <div className="mt-2 space-y-1">
          <div className={CALLOUT_LINE}>
            {shortIdLabel(parsed.active)} → {shortIdLabel(parsed.other)}
          </div>
          <div className={CALLOUT_MUTED}>
            рёбра: {parsed.srcEdge} / {parsed.tgtEdge}
          </div>
        </div>
      ) : null}
      <div className={`${CALLOUT_SECTION} mt-2`}>Углы (мир, X Z) и отрезок границы</div>
      {cornerChecks.map((row) => (
        <div
          key={row.name}
          className="mb-1 cursor-default rounded border border-transparent px-0.5 pb-1 last:mb-0 hover:border-fuchsia-500/35 hover:bg-slate-800/50"
          onPointerEnter={() => onHoverCornerSegment(row.name)}
        >
          <span className="font-bold text-cyan-200">{row.name}</span>{" "}
          <span className={CALLOUT_MUTED}>
            ({fmt3(row.p.x)}, {fmt3(row.p.z)})
          </span>
          <div className={`pl-2 ${CALLOUT_MUTED}`}>
            ребро {row.role} [{row.edge}]:{" "}
            <span className={row.chk.on ? "text-emerald-400" : "text-rose-400"}>
              {row.chk.on ? "на отрезке ✓" : "вне ✗"}
            </span>
            {row.chk.len > 1e-6 ? (
              <span className={CALLOUT_MUTED}>
                {" "}
                d⊥={fmt3(row.chk.perp)} т={fmt3(row.chk.along)}/{fmt3(row.chk.len)}
              </span>
            ) : (
              <span className={CALLOUT_MUTED}> d⊥={fmt3(row.chk.perp)}</span>
            )}
          </div>
          <div className={`pl-2 ${CALLOUT_MUTED}`}>
            min до контура active: {row.minA !== null ? fmt3(row.minA) : "—"} · other:{" "}
            {row.minO !== null ? fmt3(row.minO) : "—"}
          </div>
        </div>
      ))}
      <div className={`${CALLOUT_MUTED} mt-1`}>
        Допуск «на отрезке»: {fmt3(PROXIMITY_CORNER_ON_EDGE_EPS_M)} м (перп. и по длине).
      </div>
      <div className={`${CALLOUT_SECTION} mt-2`}>Якорь и габариты</div>
      <div className={CALLOUT_MUTED}>
        центр якоря: {fmt3(labelPos[0])}, {fmt3(labelPos[1])}, {fmt3(labelPos[2])}
      </div>
      <div className={CALLOUT_MUTED}>стороны: {spans.map((s) => fmt3(s)).join(" · ")} м</div>
    </div>
  );

  return (
    <DebugCalloutAnchor
      base={labelPos}
      sideSign={debugCalloutSideSign(area.id)}
      radialOrigin={radialOrigin}
    >
      <Billboard follow>
        <Html
          center
          occlude={false}
          style={{ pointerEvents: "auto", userSelect: "none", width: "max-content" }}
        >
          <DraggableCalloutChrome
            dragId={area.id}
            pixelOffset={pixelOffset}
            onPixelDragDelta={onPixelDragDelta}
          >
            <DebugCalloutPanel
              variant="proximity"
              heading="Зона близости"
              brief={brief}
              detail={detail}
              copyText={copyText}
            />
          </DraggableCalloutChrome>
        </Html>
      </Billboard>
    </DebugCalloutAnchor>
  );
}

function modelBoundsOutlinePositions(bounds: ModelBounds): Float32Array {
  const { minX, maxX, minZ, maxZ, minY } = bounds;
  const y = minY;
  return new Float32Array([
    minX,
    y,
    minZ,
    maxX,
    y,
    minZ,
    maxX,
    y,
    minZ,
    maxX,
    y,
    maxZ,
    maxX,
    y,
    maxZ,
    minX,
    y,
    maxZ,
    minX,
    y,
    maxZ,
    minX,
    y,
    minZ,
  ]);
}

/** Контур по bounds; raycast отключён, чтобы не перехватывать перенос/вращение (THREE.Line, не SVG `<line>`). */
function NonPickableFootprintOutline({
  bounds,
  color,
  depthTest = true,
}: {
  bounds: ModelBounds;
  color: string;
  depthTest?: boolean;
}) {
  const lineObject = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(modelBoundsOutlinePositions(bounds), 3),
    );
    const material = new THREE.LineBasicMaterial({ color, depthTest });
    const line = new THREE.Line(geometry, material);
    line.raycast = () => {};
    return line;
  }, [bounds, color, depthTest]);

  useEffect(
    () => () => {
      lineObject.geometry.dispose();
      const mat = lineObject.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat.dispose();
      }
    },
    [lineObject],
  );

  return <primitive object={lineObject} />;
}

function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function getGroundPointFromEvent(event: ThreeEvent<PointerEvent>): THREE.Vector3 | null {
  const point = new THREE.Vector3();
  const hit = event.ray.intersectPlane(GROUND_PLANE, point);
  return hit ? point : null;
}

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

function updateSelectionBounds(object: THREE.Group): ModelBounds {
  object.updateWorldMatrix(true, true);

  const worldBox = new THREE.Box3().setFromObject(object, true);
  if (worldBox.isEmpty()) {
    return {
      minX: -1,
      maxX: 1,
      minY: 0,
      maxY: 2.5,
      minZ: -1,
      maxZ: 1,
    };
  }

  const invRoot = new THREE.Matrix4().copy(object.matrixWorld).invert();
  const corner = new THREE.Vector3();
  const localBox = new THREE.Box3();
  const corners: Array<[number, number, number]> = [
    [worldBox.min.x, worldBox.min.y, worldBox.min.z],
    [worldBox.min.x, worldBox.min.y, worldBox.max.z],
    [worldBox.min.x, worldBox.max.y, worldBox.min.z],
    [worldBox.min.x, worldBox.max.y, worldBox.max.z],
    [worldBox.max.x, worldBox.min.y, worldBox.min.z],
    [worldBox.max.x, worldBox.min.y, worldBox.max.z],
    [worldBox.max.x, worldBox.max.y, worldBox.min.z],
    [worldBox.max.x, worldBox.max.y, worldBox.max.z],
  ];
  for (const [x, y, z] of corners) {
    corner.set(x, y, z).applyMatrix4(invRoot);
    localBox.expandByPoint(corner);
  }

  return {
    minX: localBox.min.x,
    maxX: localBox.max.x,
    minY: localBox.min.y,
    maxY: localBox.max.y,
    minZ: localBox.min.z,
    maxZ: localBox.max.z,
  };
}

/** Матрицы для расчёта следа без лишних аллокаций (синхронно в useMemo). */
const _footprintWorld = {
  placement: new THREE.Matrix4(),
  world: new THREE.Matrix4(),
  v: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  pos: new THREE.Vector3(),
  scale: new THREE.Vector3(1, 1, 1),
  yAxis: new THREE.Vector3(0, 1, 0),
};

/**
 * След на земле в мировых XZ: как у `<group placement> * <primitive object />` с контуром по bounds —
 * placement * object.matrix * (угол bounds на «полу»), без ручного bounds+position и без потери rotation/scale.
 */
function computeWorldFootprintFromObject(
  object: THREE.Group,
  bounds: ModelBounds,
  placement: IfcModelItem["placement"],
): {
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  minY: number;
  maxY: number;
} {
  object.updateMatrix();
  _footprintWorld.q.setFromAxisAngle(_footprintWorld.yAxis, placement.rotationY);
  _footprintWorld.pos.set(placement.x, placement.y, placement.z);
  _footprintWorld.placement.compose(_footprintWorld.pos, _footprintWorld.q, _footprintWorld.scale);
  _footprintWorld.world.multiplyMatrices(_footprintWorld.placement, object.matrix);

  const { minX, maxX, minY, maxY, minZ, maxZ } = bounds;
  const yFloor = minY;
  const xz: Array<[number, number]> = [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
  const corners = xz.map(([x, z]) => {
    _footprintWorld.v.set(x, yFloor, z).applyMatrix4(_footprintWorld.world);
    return { x: _footprintWorld.v.x, z: _footprintWorld.v.z };
  }) as [GroundPoint, GroundPoint, GroundPoint, GroundPoint];

  let wMinY = Number.POSITIVE_INFINITY;
  let wMaxY = Number.NEGATIVE_INFINITY;
  for (const x of [minX, maxX] as const) {
    for (const y of [minY, maxY] as const) {
      for (const z of [minZ, maxZ] as const) {
        _footprintWorld.v.set(x, y, z).applyMatrix4(_footprintWorld.world);
        wMinY = Math.min(wMinY, _footprintWorld.v.y);
        wMaxY = Math.max(wMaxY, _footprintWorld.v.y);
      }
    }
  }

  return { corners, minY: wMinY, maxY: wMaxY };
}

function getFootprintSegments(
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint],
): Array<[GroundPoint, GroundPoint]> {
  return [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
}

function getFootprintEdgeSegments(
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint],
): GroundSegment[] {
  return [
    { edge: "top", start: corners[0], end: corners[1] },
    { edge: "right", start: corners[1], end: corners[2] },
    { edge: "bottom", start: corners[2], end: corners[3] },
    { edge: "left", start: corners[3], end: corners[0] },
  ];
}

function getSegmentAngle(segment: GroundSegment): number {
  return Math.atan2(segment.end.z - segment.start.z, segment.end.x - segment.start.x);
}

function getParallelDelta(a: GroundSegment, b: GroundSegment): number {
  const diff = Math.abs(normalizeAngle(getSegmentAngle(a) - getSegmentAngle(b)));
  return Math.min(diff, Math.abs(Math.PI - diff));
}

/** Минимальный поворот вокруг Y, чтобы направление ребра θa совпало с θb (с учётом обратного направления ребра). */
function rotationShortestToParallelEdgeDirections(thetaA: number, thetaB: number): number {
  const o1 = normalizeAngle(thetaB - thetaA);
  const o2 = normalizeAngle(thetaB + Math.PI - thetaA);
  return Math.abs(o1) <= Math.abs(o2) ? o1 : o2;
}

/** Подтягивает rotationY к параллели пары рёбер (магнит при вращении). */
function applyParallelEdgeRotationSnap(
  placement: IfcModelItem["placement"],
  activeModelId: string,
  sceneModelsList: Array<{ model: IfcModelItem; object: THREE.Group; bounds: ModelBounds }>,
): IfcModelItem["placement"] {
  if (sceneModelsList.length < 2) return placement;
  const entry = sceneModelsList.find((s) => s.model.id === activeModelId);
  if (!entry) return placement;
  const { corners } = computeWorldFootprintFromObject(entry.object, entry.bounds, placement);
  const activeSegs = getFootprintEdgeSegments(corners);
  const candidates: Array<{ distSq: number; sa: GroundSegment; tb: GroundSegment }> = [];

  for (const s of sceneModelsList) {
    if (s.model.id === activeModelId) continue;
    const o = computeWorldFootprintFromObject(s.object, s.bounds, s.model.placement);
    const targetSegs = getFootprintEdgeSegments(o.corners);
    for (const sa of activeSegs) {
      for (const tb of targetSegs) {
        const bridge = closestPointsOnSegments2D(sa.start, sa.end, tb.start, tb.end);
        candidates.push({ distSq: bridge.distanceSq, sa, tb });
      }
    }
  }
  candidates.sort((a, b) => a.distSq - b.distSq);
  for (const { distSq, sa, tb } of candidates) {
    if (distSq < 1e-12) continue;
    const err = getParallelDelta(sa, tb);
    if (err > ROTATE_PARALLEL_EDGE_MAGNET_RAD) continue;
    const angA = getSegmentAngle(sa);
    const angT = getSegmentAngle(tb);
    const adj = rotationShortestToParallelEdgeDirections(angA, angT);
    const t = Math.max(0, 1 - err / ROTATE_PARALLEL_EDGE_MAGNET_RAD);
    const applied = adj * t;
    return { ...placement, rotationY: normalizeAngle(placement.rotationY + applied) };
  }
  return placement;
}

function getParallelLineDistance(a: GroundSegment, b: GroundSegment): number {
  const dx = a.end.x - a.start.x;
  const dz = a.end.z - a.start.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return Number.POSITIVE_INFINITY;
  return Math.abs((b.start.x - a.start.x) * dz - (b.start.z - a.start.z) * dx) / length;
}

/**
 * Сдвиг центра модели (XZ), устраняющий зазор между параллельными прямыми ребёр
 * (перенос всего следа на вектор, зануляющий 2D cross для target.start относительно прямой source).
 */
function parallelFacePlacementCorrection(source: GroundSegment, target: GroundSegment): {
  dx: number;
  dz: number;
} | null {
  const ddx = source.end.x - source.start.x;
  const ddz = source.end.z - source.start.z;
  const L2 = ddx * ddx + ddz * ddz;
  if (L2 < 1e-12) return null;
  const cross = (target.start.x - source.start.x) * ddz - (target.start.z - source.start.z) * ddx;
  const k = cross / L2;
  return { dx: k * ddz, dz: -k * ddx };
}

/** Лучшая пара параллельных рёбер в зоне магнита → сдвиг placement. */
function computeParallelFaceMagnetDelta(
  activeCorners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint],
  otherFootprints: ModelGroundFootprint[],
): { dx: number; dz: number } | null {
  const activeEdges = getFootprintEdgeSegments(activeCorners);
  let bestDist = Number.POSITIVE_INFINITY;
  let bestPair: { source: GroundSegment; target: GroundSegment } | null = null;

  for (const fp of otherFootprints) {
    const targetEdges = getFootprintEdgeSegments(fp.corners);
    for (const source of activeEdges) {
      for (const target of targetEdges) {
        if (getParallelDelta(source, target) > PARALLEL_EDGE_TOLERANCE) continue;
        const dist = getParallelLineDistance(source, target);
        if (!Number.isFinite(dist) || dist >= PARALLEL_FACE_MAGNET_DISTANCE) continue;
        if (dist < bestDist) {
          bestDist = dist;
          bestPair = { source, target };
        }
      }
    }
  }
  if (!bestPair) return null;
  return parallelFacePlacementCorrection(bestPair.source, bestPair.target);
}

function getPointLineProjection(point: GroundPoint, line: GroundSegment) {
  const dx = line.end.x - line.start.x;
  const dz = line.end.z - line.start.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 1e-6) return null;

  const ux = dx / length;
  const uz = dz / length;
  const projection = (point.x - line.start.x) * ux + (point.z - line.start.z) * uz;
  const projectedPoint = {
    x: line.start.x + ux * projection,
    z: line.start.z + uz * projection,
  };
  const distance = Math.hypot(point.x - projectedPoint.x, point.z - projectedPoint.z);

  return { distance, length, projectedPoint, projection, ux, uz };
}

function buildProjectedPointSegment(
  point: GroundPoint,
  line: GroundSegment,
): GroundSegment | null {
  const projection = getPointLineProjection(point, line);
  if (!projection) return null;

  const halfLength = 0.25;
  return {
    edge: line.edge,
    start: {
      x: projection.projectedPoint.x - projection.ux * halfLength,
      z: projection.projectedPoint.z - projection.uz * halfLength,
    },
    end: {
      x: projection.projectedPoint.x + projection.ux * halfLength,
      z: projection.projectedPoint.z + projection.uz * halfLength,
    },
  };
}

function buildProximityHatchArea(
  source: GroundSegment,
  target: GroundSegment,
  id: string,
): Omit<ProximityHatchArea, "sourceModelId" | "targetModelId"> | null {
  const dx = source.end.x - source.start.x;
  const dz = source.end.z - source.start.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 1e-6) return null;

  const ux = dx / length;
  const uz = dz / length;

  // Оба «bottom» в локали могут иметь противоположный обход → в мире направления разошлись на 180°.
  // Без выравнивания перекрытие по одной оси и полоса между рёбрами считаются по-разному при swap source/target.
  let t = target;
  const tdx0 = t.end.x - t.start.x;
  const tdz0 = t.end.z - t.start.z;
  const tlen0 = Math.hypot(tdx0, tdz0);
  if (tlen0 < 1e-9) return null;
  if ((ux * tdx0 + uz * tdz0) / tlen0 < 0) {
    t = { ...t, start: t.end, end: t.start };
  }

  const project = (point: GroundPoint) =>
    (point.x - source.start.x) * ux + (point.z - source.start.z) * uz;

  const sourceStart = project(source.start);
  const sourceEnd = project(source.end);
  const targetStart = project(t.start);
  const targetEnd = project(t.end);
  const sourceMin = Math.min(sourceStart, sourceEnd);
  const sourceMax = Math.max(sourceStart, sourceEnd);
  const targetMin = Math.min(targetStart, targetEnd);
  const targetMax = Math.max(targetStart, targetEnd);
  const overlapStart = Math.max(
    sourceMin,
    targetMin,
  );
  const overlapEnd = Math.min(
    sourceMax,
    targetMax,
  );
  // Только вырожденный случай: нет общего отрезка по направлению ребра (не отсекаем узкие коридоры).
  if (overlapEnd - overlapStart < 1e-5) return null;

  const hatchStart = overlapStart;
  const hatchEnd = overlapEnd;

  const bridge = closestPointsOnSegments2D(
    source.start,
    source.end,
    t.start,
    t.end,
  );
  const bridgeLen = Math.sqrt(bridge.distanceSq);
  if (!Number.isFinite(bridgeLen) || bridgeLen < 1e-5 || bridgeLen > PROXIMITY_HATCH_DISTANCE) {
    return null;
  }
  const gdx = bridge.b.x - bridge.a.x;
  const gdz = bridge.b.z - bridge.a.z;
  const alongEdge = Math.abs(gdx * ux + gdz * uz);
  // Без жёсткой добавки 1e-4 — при микрозазоре она ломала почти параллельные пары.
  if (alongEdge > 0.2 * bridgeLen + 1e-7) return null;

  // Перпендикуляр к ребру в XZ и точное расстояние между параллельными прямыми (без нормализации моста — иначе зазор «плывёт»).
  let normalX = -uz;
  let normalZ = ux;
  const smx = (source.start.x + source.end.x) * 0.5;
  const smz = (source.start.z + source.end.z) * 0.5;
  const tmx = (t.start.x + t.end.x) * 0.5;
  const tmz = (t.start.z + t.end.z) * 0.5;
  if ((tmx - smx) * normalX + (tmz - smz) * normalZ < 0) {
    normalX = -normalX;
    normalZ = -normalZ;
  }
  const offsetAlongN =
    (t.start.x - source.start.x) * normalX +
    (t.start.z - source.start.z) * normalZ;
  const gapMag = Math.abs(offsetAlongN);
  if (gapMag <= 1e-6 || gapMag > PROXIMITY_HATCH_DISTANCE) return null;

  const signedOffset = offsetAlongN;

  const pointOnSource = (value: number): GroundPoint => ({
    x: source.start.x + ux * value,
    z: source.start.z + uz * value,
  });
  const pointOnTarget = (value: number): GroundPoint => ({
    x: source.start.x + ux * value + normalX * signedOffset,
    z: source.start.z + uz * value + normalZ * signedOffset,
  });

  const a = pointOnSource(hatchStart);
  const b = pointOnSource(hatchEnd);
  const c = pointOnTarget(hatchEnd);
  const d = pointOnTarget(hatchStart);

  const hatchSegments: Array<[GroundPoint, GroundPoint]> = [];
  const offsetSign = Math.sign(signedOffset);
  const offsetMin = Math.min(0, signedOffset);
  const offsetMax = Math.max(0, signedOffset);
  const localToWorld = (projection: number, offset: number): GroundPoint => ({
    x: source.start.x + ux * projection + normalX * offset,
    z: source.start.z + uz * projection + normalZ * offset,
  });
  const minKey = Math.min(
    hatchStart - offsetSign * offsetMin,
    hatchStart - offsetSign * offsetMax,
    hatchEnd - offsetSign * offsetMin,
    hatchEnd - offsetSign * offsetMax,
  );
  const maxKey = Math.max(
    hatchStart - offsetSign * offsetMin,
    hatchStart - offsetSign * offsetMax,
    hatchEnd - offsetSign * offsetMin,
    hatchEnd - offsetSign * offsetMax,
  );

  for (
    let key = minKey - PROXIMITY_HATCH_STEP;
    key <= maxKey + PROXIMITY_HATCH_STEP;
    key += PROXIMITY_HATCH_STEP
  ) {
    const intersections: Array<{ projection: number; offset: number }> = [];
    const addIntersection = (projection: number, offset: number) => {
      if (
        projection < hatchStart - 1e-6 ||
        projection > hatchEnd + 1e-6 ||
        offset < offsetMin - 1e-6 ||
        offset > offsetMax + 1e-6
      ) {
        return;
      }
      if (
        intersections.some(
          (item) =>
            Math.abs(item.projection - projection) < 1e-5 &&
            Math.abs(item.offset - offset) < 1e-5,
        )
      ) {
        return;
      }
      intersections.push({ projection, offset });
    };

    addIntersection(hatchStart, offsetSign * (hatchStart - key));
    addIntersection(hatchEnd, offsetSign * (hatchEnd - key));
    addIntersection(key + offsetSign * offsetMin, offsetMin);
    addIntersection(key + offsetSign * offsetMax, offsetMax);

    if (intersections.length < 2) continue;

    let start = intersections[0];
    let end = intersections[1];
    let bestDistance = -1;
    for (let first = 0; first < intersections.length; first += 1) {
      for (let second = first + 1; second < intersections.length; second += 1) {
        const distance = Math.hypot(
          intersections[first].projection - intersections[second].projection,
          intersections[first].offset - intersections[second].offset,
        );
        if (distance <= bestDistance) continue;
        bestDistance = distance;
        start = intersections[first];
        end = intersections[second];
      }
    }

    if (bestDistance < 0.008) continue;
    hatchSegments.push([
      localToWorld(start.projection, start.offset),
      localToWorld(end.projection, end.offset),
    ]);
  }

  // Углы A,B строятся вдоль source; C,D — вдоль той же оси на смещении по нормали. При «почти
  // параллельных» рёбрах (<3° в отборе) прямая C–D может не совпасть с отрезком target — тогда
  // штриховка вводит в заблуждение (см. отладку d⊥ у C/D). Не показываем такую зону.
  if (
    !groundPointOnSegment(a, source).on ||
    !groundPointOnSegment(b, source).on ||
    !groundPointOnSegment(c, target).on ||
    !groundPointOnSegment(d, target).on
  ) {
    return null;
  }

  return {
    id,
    corners: [a, b, c, d],
    hatchSegments,
    source,
    target,
    bridgeA: { x: bridge.a.x, z: bridge.a.z },
    bridgeB: { x: bridge.b.x, z: bridge.b.z },
    gapDistance: bridgeLen,
  };
}

/**
 * Полоса строится вдоль первого аргумента; при разной длине параллельных рёбер перекрытие по
 * проекции может для одной ориентации пройти проверки, для другой — нет → зона «пропадает»
 * при смене активной модели. Пробуем обе ориентации, в API всегда source = ребро active, target = other.
 */
function buildProximityHatchAreaForPair(
  activeEdge: GroundSegment,
  otherEdge: GroundSegment,
  id: string,
): Omit<ProximityHatchArea, "sourceModelId" | "targetModelId"> | null {
  const primary = buildProximityHatchArea(activeEdge, otherEdge, id);
  if (primary) return primary;
  const flipped = buildProximityHatchArea(otherEdge, activeEdge, id);
  if (!flipped) return null;
  return {
    ...flipped,
    id,
    source: activeEdge,
    target: otherEdge,
  };
}

/** Проверка: лежит ли точка на отрезке в XZ (перпендикуляр и параметр вдоль). */
function groundPointOnSegment(
  p: GroundPoint,
  seg: GroundSegment,
  epsDist = PROXIMITY_CORNER_ON_EDGE_EPS_M,
  epsAlong = PROXIMITY_CORNER_ON_EDGE_EPS_M,
): { on: boolean; perp: number; along: number; len: number } {
  const dx = seg.end.x - seg.start.x;
  const dz = seg.end.z - seg.start.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) {
    return {
      on: Math.hypot(p.x - seg.start.x, p.z - seg.start.z) <= epsDist,
      perp: Math.hypot(p.x - seg.start.x, p.z - seg.start.z),
      along: 0,
      len: 0,
    };
  }
  const ux = dx / len;
  const uz = dz / len;
  const along = (p.x - seg.start.x) * ux + (p.z - seg.start.z) * uz;
  const qx = seg.start.x + ux * along;
  const qz = seg.start.z + uz * along;
  const perp = Math.hypot(p.x - qx, p.z - qz);
  const on = perp <= epsDist && along >= -epsAlong && along <= len + epsAlong;
  return { on, perp, along, len };
}

function proximitySegmentHighlightLineXZ(seg: GroundSegment, y: number): Float32Array {
  return new Float32Array([
    seg.start.x,
    y,
    seg.start.z,
    seg.end.x,
    y,
    seg.end.z,
  ]);
}

/** Минимальное расстояние до любого из отрезков границы следа (м). */
function minDistanceToFootprintEdges(p: GroundPoint, corners: ModelGroundFootprint["corners"]) {
  const segs = getFootprintEdgeSegments(corners);
  let best = Number.POSITIVE_INFINITY;
  for (const s of segs) {
    const pr = getPointLineProjection(p, s);
    if (!pr) continue;
    const t = pr.projection;
    let d: number;
    if (t < 0) d = Math.hypot(p.x - s.start.x, p.z - s.start.z);
    else if (t > pr.length) d = Math.hypot(p.x - s.end.x, p.z - s.end.z);
    else d = pr.distance;
    best = Math.min(best, d);
  }
  return best;
}

function getFootprintExtents(footprint: ModelGroundFootprint) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const corner of footprint.corners) {
    minX = Math.min(minX, corner.x);
    maxX = Math.max(maxX, corner.x);
    minZ = Math.min(minZ, corner.z);
    maxZ = Math.max(maxZ, corner.z);
  }

  return { minX, maxX, minZ, maxZ };
}

function snapAngle(angle: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return angle;
  return normalizeAngle(Math.round(angle / step) * step);
}

function cross2D(a: GroundPoint, b: GroundPoint, c: GroundPoint): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function pointInConvexQuad(
  point: GroundPoint,
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint],
): boolean {
  let positive = false;
  let negative = false;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const cross = cross2D(a, b, point);
    if (cross > 1e-6) positive = true;
    if (cross < -1e-6) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

function closestPointsOnSegments2D(
  p1: GroundPoint,
  p2: GroundPoint,
  q1: GroundPoint,
  q2: GroundPoint,
): { a: GroundPoint; b: GroundPoint; distanceSq: number } {
  const ux = p2.x - p1.x;
  const uz = p2.z - p1.z;
  const vx = q2.x - q1.x;
  const vz = q2.z - q1.z;
  const wx = p1.x - q1.x;
  const wz = p1.z - q1.z;

  const a = ux * ux + uz * uz;
  const b = ux * vx + uz * vz;
  const c = vx * vx + vz * vz;
  const d = ux * wx + uz * wz;
  const e = vx * wx + vz * wz;
  const D = a * c - b * b;
  const EPS = 1e-9;

  let sN: number;
  let sD = D;
  let tN: number;
  let tD = D;

  if (D < EPS) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }

  if (tN < 0) {
    tN = 0;
    if (-d < 0) {
      sN = 0;
    } else if (-d > a) {
      sN = sD;
    } else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) {
      sN = 0;
    } else if (-d + b > a) {
      sN = sD;
    } else {
      sN = -d + b;
      sD = a;
    }
  }

  const sc = Math.abs(sN) < EPS ? 0 : sN / sD;
  const tc = Math.abs(tN) < EPS ? 0 : tN / tD;

  const ax = p1.x + sc * ux;
  const az = p1.z + sc * uz;
  const bx = q1.x + tc * vx;
  const bz = q1.z + tc * vz;
  const dx = ax - bx;
  const dz = az - bz;
  return {
    a: { x: ax, z: az },
    b: { x: bx, z: bz },
    distanceSq: dx * dx + dz * dz,
  };
}

function formatMeters(value: number): string {
  if (value >= 10) return `${value.toFixed(1)}\u00A0м`;
  return `${value.toFixed(2)}\u00A0м`;
}

/** Размерная линия между двумя точками на земле (как при трансформации): центры → точки, синий зазор, подпись. */
function FootprintGapMeasurementVisual({
  start,
  end,
  sourceCenter,
  targetCenter,
  label,
  distance,
}: Omit<MeasurementLine, "id">) {
  return (
    <group>
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([...sourceCenter, ...start]), 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#334155" />
      </line>
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([...targetCenter, ...end]), 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#334155" />
      </line>
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([...start, ...end]), 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#3b82f6" />
      </line>
      <mesh position={start}>
        <sphereGeometry args={[0.18, 18, 18]} />
        <meshBasicMaterial color="#60a5fa" />
      </mesh>
      <mesh position={end}>
        <sphereGeometry args={[0.18, 18, 18]} />
        <meshBasicMaterial color="#22d3ee" />
      </mesh>
      <Html
        position={label}
        center
        transform={false}
        style={{ pointerEvents: "none", fontSize: "20px", lineHeight: "1.1" }}
      >
        <div className="whitespace-nowrap rounded-md border-2 border-cyan-200/90 bg-slate-950/95 px-3 py-1.5 text-sm font-bold tracking-[0.01em] text-cyan-100 shadow-[0_8px_24px_rgba(0,0,0,0.65)]">
          {formatMeters(distance)}
        </div>
      </Html>
    </group>
  );
}

function geometryCacheKey(model: IfcModelItem): string {
  return `${model.name}:${model.size}:${model.file.lastModified}:${model.geometryRevision}`;
}

/** Tabler Icons outline: arrows-maximize — курсор для переноса в плоскости XY. */
const CURSOR_TABLER_ARROWS_MAXIMIZE = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M16 4l4 0l0 4" /><path d="M14 10l6 -6" /><path d="M8 20l-4 0l0 -4" /><path d="M4 20l6 -6" /><path d="M16 20l4 0l0 -4" /><path d="M14 14l6 6" /><path d="M8 4l-4 0l0 4" /><path d="M4 4l6 6" /></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, move`;
})();

/** Tabler Icons outline: rotate-360 — курсор для вращения. */
const CURSOR_TABLER_ROTATE_360 = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 16h4v4" /><path d="M19.458 11.042c.86 -2.366 .722 -4.58 -.6 -5.9c-2.272 -2.274 -7.185 -1.045 -10.973 2.743c-3.788 3.788 -5.017 8.701 -2.744 10.974c2.227 2.226 6.987 1.093 10.74 -2.515" /></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
})();

function disposeObjectResources(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) materials.add(item);
    } else if (material) {
      materials.add(material);
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

/** Кольцевая дуга 90° в плоскости XZ (квадрант от осей xDir/zDir). */
function createQuarterArcRingGeometry(
  innerRadius: number,
  outerRadius: number,
  xDir: 1 | -1,
  zDir: 1 | -1,
  segments = 28,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const pushPoint = (radius: number, angle: number) => {
    positions.push(
      xDir * radius * Math.cos(angle),
      0,
      zDir * radius * Math.sin(angle),
    );
  };
  for (let index = 0; index < segments; index += 1) {
    const start = (index / segments) * (Math.PI / 2);
    const end = ((index + 1) / segments) * (Math.PI / 2);
    pushPoint(innerRadius, start);
    pushPoint(outerRadius, start);
    pushPoint(outerRadius, end);
    pushPoint(innerRadius, start);
    pushPoint(outerRadius, end);
    pushPoint(innerRadius, end);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Зона захвата по схеме: сектор от вершины (центр поворота в углу) до внешнего радиуса,
 * тот же 90° что и у видимой дуги + небольшой угловой запас по краям.
 */
function createQuarterSectorHitGeometry(
  outerRadius: number,
  xDir: 1 | -1,
  zDir: 1 | -1,
  anglePadRad: number,
  segments = 40,
): THREE.BufferGeometry {
  const angleStart = -anglePadRad;
  const angleEnd = Math.PI / 2 + anglePadRad;
  const positions: number[] = [];
  const indices: number[] = [];
  positions.push(0, 0, 0);
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const angle = angleStart + t * (angleEnd - angleStart);
    positions.push(
      xDir * outerRadius * Math.cos(angle),
      0,
      zDir * outerRadius * Math.sin(angle),
    );
  }
  for (let i = 0; i < segments; i += 1) {
    indices.push(0, i + 1, i + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

function RotateCornerHandle({
  xDir,
  zDir,
  color,
  innerRadius,
  thickness,
  active,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerOver,
  onPointerOut,
}: {
  xDir: 1 | -1;
  zDir: 1 | -1;
  color: string;
  innerRadius: number;
  thickness: number;
  active: boolean;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (event: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (event: ThreeEvent<PointerEvent>) => void;
  onPointerCancel: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOver: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const { invalidate } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const visualMeshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const highlightLerp = useRef(0);
  const baseColor = useMemo(() => new THREE.Color(color), [color]);
  const hotColor = useMemo(() => {
    const c = new THREE.Color(color);
    c.offsetHSL(0, 0.08, 0.14);
    return c;
  }, [color]);

  useEffect(() => {
    invalidate();
  }, [active, invalidate]);

  // Видимая дуга не участвует в raycast — попадания по невидимому сектору от угла (см. схему зоны).
  useEffect(() => {
    const mesh = visualMeshRef.current;
    if (!mesh) return;
    mesh.raycast = () => {};
  }, []);

  useFrame((_, delta) => {
    const target = active ? 1 : 0;
    highlightLerp.current = THREE.MathUtils.lerp(
      highlightLerp.current,
      target,
      1 - Math.exp(-14 * delta),
    );
    const h = highlightLerp.current;
    if (groupRef.current) {
      const s = THREE.MathUtils.lerp(1, 1.1, h);
      groupRef.current.scale.setScalar(s);
    }
    if (materialRef.current) {
      materialRef.current.color.copy(baseColor).lerp(hotColor, h);
      materialRef.current.opacity = THREE.MathUtils.lerp(0.78, 1, h);
    }
    if (Math.abs(highlightLerp.current - target) > 0.002) invalidate();
  });

  const arcGeometry = useMemo(
    () => createQuarterArcRingGeometry(innerRadius, innerRadius + thickness, xDir, zDir),
    [innerRadius, thickness, xDir, zDir],
  );

  // Радиальный запас за внешней кромкой дуги; угловой — отдельно (сектор шире 90° на anglePad).
  const hitPad = useMemo(
    () => THREE.MathUtils.clamp(thickness * 0.65, 0.12, 0.42),
    [thickness],
  );
  const angleHitPad = useMemo(
    () => THREE.MathUtils.degToRad(THREE.MathUtils.clamp(thickness * 18, 4, 10)),
    [thickness],
  );
  const hitGeometry = useMemo(() => {
    const hitOuter = innerRadius + thickness + hitPad;
    return createQuarterSectorHitGeometry(hitOuter, xDir, zDir, angleHitPad);
  }, [innerRadius, thickness, hitPad, angleHitPad, xDir, zDir]);

  return (
    <group ref={groupRef}>
      <mesh
        geometry={hitGeometry}
        renderOrder={17}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
      >
        <meshBasicMaterial
          transparent
          opacity={0}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh ref={visualMeshRef} geometry={arcGeometry} renderOrder={18}>
        <meshBasicMaterial
          ref={materialRef}
          color={color}
          depthTest={false}
          opacity={0.78}
          side={THREE.DoubleSide}
          transparent
        />
      </mesh>
    </group>
  );
}

function AlignmentPlaneHighlight({
  source,
  target,
  spanPoints,
  minY,
  maxY,
}: {
  source: GroundSegment;
  target: GroundSegment;
  spanPoints: GroundPoint[];
  minY: number;
  maxY: number;
}) {
  const positions = useMemo(() => {
    const dx = source.end.x - source.start.x;
    const dz = source.end.z - source.start.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-6) return new Float32Array();

    const ux = dx / length;
    const uz = dz / length;
    const normalX = -uz;
    const normalZ = ux;
    const signedOffset =
      (target.start.x - source.start.x) * normalX +
      (target.start.z - source.start.z) * normalZ;
    const baseX = source.start.x + normalX * signedOffset * 0.5;
    const baseZ = source.start.z + normalZ * signedOffset * 0.5;

    const project = (point: GroundPoint) =>
      (point.x - baseX) * ux + (point.z - baseZ) * uz;
    const points = spanPoints.length > 0
      ? spanPoints
      : [source.start, source.end, target.start, target.end];
    const values = points.map(project);
    const minProjection = Math.min(...values);
    const maxProjection = Math.max(...values);
    const y0 = Number.isFinite(minY) ? minY : 0;
    const y1 = Math.max(Number.isFinite(maxY) ? maxY : 2.5, y0 + 0.2);

    const startX = baseX + ux * minProjection;
    const startZ = baseZ + uz * minProjection;
    const endX = baseX + ux * maxProjection;
    const endZ = baseZ + uz * maxProjection;

    return new Float32Array([
      startX,
      y0,
      startZ,
      endX,
      y0,
      endZ,
      endX,
      y1,
      endZ,
      startX,
      y0,
      startZ,
      endX,
      y1,
      endZ,
      startX,
      y1,
      startZ,
    ]);
  }, [maxY, minY, source, spanPoints, target]);

  if (positions.length === 0) return null;

  return (
    <mesh renderOrder={30}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshBasicMaterial
        color={ALIGNMENT_PLANE_COLOR}
        depthTest={false}
        depthWrite={false}
        opacity={0.2}
        side={THREE.DoubleSide}
        transparent
      />
    </mesh>
  );
}

function ProximityHatchOverlay({
  area,
  footprints,
  radialOrigin,
  pixelOffset,
  onPixelDragDelta,
  showDebugCallout,
}: {
  area: ProximityHatchArea;
  footprints: ModelGroundFootprint[];
  radialOrigin: { x: number; z: number } | null;
  pixelOffset: { x: number; y: number };
  onPixelDragDelta: (id: string, dx: number, dy: number) => void;
  showDebugCallout: boolean;
}) {
  const [hoverEdge, setHoverEdge] = useState<"source" | "target" | null>(null);

  const handleCornerHover = useCallback((corner: "A" | "B" | "C" | "D" | null) => {
    if (corner === null) {
      setHoverEdge(null);
      return;
    }
    setHoverEdge(corner === "A" || corner === "B" ? "source" : "target");
  }, []);

  const highlightSourcePositions = useMemo(
    () => proximitySegmentHighlightLineXZ(area.source, PROXIMITY_EDGE_HIGHLIGHT_Y),
    [area.source],
  );
  const highlightTargetPositions = useMemo(
    () => proximitySegmentHighlightLineXZ(area.target, PROXIMITY_EDGE_HIGHLIGHT_Y + 0.006),
    [area.target],
  );

  const proximityGapMeasurement = useMemo((): Omit<MeasurementLine, "id"> | null => {
    const srcFp = footprints.find((f) => f.id === area.sourceModelId);
    const tgtFp = footprints.find((f) => f.id === area.targetModelId);
    if (!srcFp || !tgtFp) return null;
    const start: [number, number, number] = [area.bridgeA.x, 0.04, area.bridgeA.z];
    const end: [number, number, number] = [area.bridgeB.x, 0.04, area.bridgeB.z];
    const sourceCenter: [number, number, number] = [srcFp.center.x, 0.03, srcFp.center.z];
    const targetCenter: [number, number, number] = [tgtFp.center.x, 0.03, tgtFp.center.z];
    const label: [number, number, number] = [
      (start[0] + end[0]) * 0.5,
      0.11,
      (start[2] + end[2]) * 0.5,
    ];
    return { start, end, sourceCenter, targetCenter, label, distance: area.gapDistance };
  }, [area, footprints]);

  const fillPositions = useMemo(() => {
    const [a, b, c, d] = area.corners;
    const y = 0.055;
    return new Float32Array([
      a.x,
      y,
      a.z,
      b.x,
      y,
      b.z,
      c.x,
      y,
      c.z,
      a.x,
      y,
      a.z,
      c.x,
      y,
      c.z,
      d.x,
      y,
      d.z,
    ]);
  }, [area.corners]);

  const hatchPositions = useMemo(() => {
    const y = 0.065;
    const values: number[] = [];
    for (const [start, end] of area.hatchSegments) {
      values.push(start.x, y, start.z, end.x, y, end.z);
    }
    return new Float32Array(values);
  }, [area.hatchSegments]);

  const outlinePositions = useMemo(() => {
    const [a, b, c, d] = area.corners;
    const y = 0.075;
    return new Float32Array([
      a.x,
      y,
      a.z,
      b.x,
      y,
      b.z,
      b.x,
      y,
      b.z,
      c.x,
      y,
      c.z,
      c.x,
      y,
      c.z,
      d.x,
      y,
      d.z,
      d.x,
      y,
      d.z,
      a.x,
      y,
      a.z,
    ]);
  }, [area.corners]);

  return (
    <group renderOrder={20}>
      <mesh>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[fillPositions, 3]} />
        </bufferGeometry>
        <meshBasicMaterial
          color={PROXIMITY_HATCH_COLOR}
          opacity={0.09}
          side={THREE.DoubleSide}
          transparent
        />
      </mesh>
      {hatchPositions.length > 0 && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[hatchPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PROXIMITY_HATCH_COLOR} opacity={0.45} transparent />
        </lineSegments>
      )}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[outlinePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={PROXIMITY_HATCH_COLOR} opacity={0.75} transparent />
      </lineSegments>
      {hoverEdge === "source" && (
        <lineSegments renderOrder={32}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[highlightSourcePositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            color={PROXIMITY_EDGE_HIGHLIGHT_COLOR}
            depthTest
            depthWrite={false}
          />
        </lineSegments>
      )}
      {hoverEdge === "target" && (
        <lineSegments renderOrder={32}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[highlightTargetPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            color={PROXIMITY_EDGE_HIGHLIGHT_COLOR}
            depthTest
            depthWrite={false}
          />
        </lineSegments>
      )}
      {proximityGapMeasurement ? (
        <FootprintGapMeasurementVisual {...proximityGapMeasurement} />
      ) : null}
      {showDebugCallout ? (
        <ProximityHatchDebugLabel
          area={area}
          footprints={footprints}
          radialOrigin={radialOrigin}
          pixelOffset={pixelOffset}
          onPixelDragDelta={onPixelDragDelta}
          onHoverCornerSegment={handleCornerHover}
        />
      ) : null}
    </group>
  );
}

/** Кадрирование по активному объекту, если нет сохранённого вида. */
function applyViewportCameraFrameToFit(
  perspective: THREE.PerspectiveCamera,
  controls: { target: THREE.Vector3; update: () => void },
  activeObject: THREE.Group | null,
  viewMode: "2d" | "3d",
) {
  const target = new THREE.Vector3(0, 0, 0);
  const bounds = activeObject ? new THREE.Box3().setFromObject(activeObject) : null;
  const hasBounds = Boolean(bounds && !bounds.isEmpty());
  const size = hasBounds ? bounds!.getSize(new THREE.Vector3()) : new THREE.Vector3(10, 10, 10);
  if (hasBounds) bounds!.getCenter(target);

  if (viewMode === "2d") {
    const topSpan = Math.max(size.x, size.z, 1);
    const fov = THREE.MathUtils.degToRad(Math.max(perspective.fov, 10));
    const distance = (topSpan * 0.8) / Math.tan(fov / 2) + Math.max(size.y, 1) + 5;

    perspective.up.set(0, 1, 0);
    perspective.position.set(target.x, target.y + distance, target.z + 0.0001);
    perspective.lookAt(target);
    controls.target.copy(target);
  } else {
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const distance = maxDim * 1.7;
    const centerY = target.y;

    perspective.up.set(0, 1, 0);
    perspective.position.set(
      target.x + distance,
      centerY + distance * 0.75,
      target.z + distance,
    );
    perspective.lookAt(target.x, centerY, target.z);
    controls.target.set(target.x, centerY, target.z);
  }
}

function CameraController({
  activeObject,
  viewMode,
  controlsRef,
}: {
  activeObject: THREE.Group | null;
  viewMode: "2d" | "3d";
  controlsRef: {
    current: OrbitControlsImpl | null;
  };
}) {
  const { camera, invalidate } = useThree();
  const activeObjectRef = useRef<THREE.Group | null>(activeObject);

  useEffect(() => {
    activeObjectRef.current = activeObject;
  }, [activeObject]);

  /** Восстановить сохранённый вид или кадрировать сцену (ref controls может появиться на следующем кадре). */
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    const tryApply = () => {
      if (cancelled) return;
      const controls = controlsRef.current;
      if (!controls) {
        raf = requestAnimationFrame(tryApply);
        return;
      }
      const perspective = camera as THREE.PerspectiveCamera;
      const stored = parseStoredViewportCameras()[viewMode];
      if (stored && isValidStoredViewportCamera(stored)) {
        perspective.position.set(...stored.position);
        controls.target.set(...stored.target);
        perspective.up.set(0, 1, 0);
        perspective.lookAt(controls.target);
      } else {
        applyViewportCameraFrameToFit(
          perspective,
          controls,
          activeObjectRef.current,
          viewMode,
        );
      }
      controls.update();
      invalidate();
    };
    raf = requestAnimationFrame(tryApply);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [camera, controlsRef, invalidate, viewMode]);

  /** Сохранять вид при орбите/панорамировании (debounce). */
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let removeListener: (() => void) | null = null;

    const attach = () => {
      if (cancelled) return;
      const controls = controlsRef.current;
      if (!controls) {
        raf = requestAnimationFrame(attach);
        return;
      }
      const perspective = camera as THREE.PerspectiveCamera;
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      const onChange = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          persistViewportCamera(viewMode, perspective.position, controls.target);
          saveTimer = null;
        }, 280);
      };
      controls.addEventListener("change", onChange);
      removeListener = () => {
        controls.removeEventListener("change", onChange);
        if (saveTimer) clearTimeout(saveTimer);
      };
    };

    raf = requestAnimationFrame(attach);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      removeListener?.();
    };
  }, [camera, controlsRef, viewMode]);

  return null;
}

export default function IfcViewport({
  models,
  activeModelId,
  workspaceMode = "parcel",
  viewMode,
  transformMode,
  devMode,
  rotationSnapEnabled,
  rotationSnapStepDegrees,
  onGeometryLoading,
  onGeometryReady,
  onGeometryError,
  onPlacementCommit,
  onSelectModel,
  onDropModel,
}: Props) {
  const [progressById, setProgressById] = useState<Record<string, number>>({});
  const [viewportScale, setViewportScale] = useState<ViewportScale | null>(null);
  const [cache, setCache] = useState<Map<string, CacheEntry>>(() => new Map());
  const cacheRef = useRef(cache);
  const [isSelected, setIsSelected] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [hoveredRotateHandleKey, setHoveredRotateHandleKey] = useState<string | null>(null);
  /** Hover над телом активной модели в режиме переноса (плоскость XY). */
  const [pointerOverMovePlane, setPointerOverMovePlane] = useState(false);
  /** Активный drag переноса/вращения — для курсора Tabler на canvas. */
  const [canvasGesture, setCanvasGesture] = useState<"move" | "rotate" | null>(null);
  const loadingKeysRef = useRef<Set<string>>(new Set());
  const loadingControllersRef = useRef<Map<string, AbortController>>(new Map());
  const progressUpdatesRef = useRef<Map<string, { at: number; value: number }>>(new Map());

  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const placementGroupRef = useRef<THREE.Group | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  /** Для явного gl.render перед снимком в буфер (frameloop: demand). */
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const alignmentSnapRef = useRef<AlignmentSnapData | null>(null);
  const instanceObjectsRef = useRef<Map<string, { geometryKey: string; object: THREE.Group }>>(
    new Map(),
  );
  /** Актуальный список сцен — для магнита параллельных граней в handlePointerMove (объявлен ниже). */
  const sceneModelsRef = useRef<
    Array<{ model: IfcModelItem; object: THREE.Group; bounds: ModelBounds }>
  >([]);

  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  const activeModel = useMemo(
    () => models.find((item) => item.id === activeModelId) ?? null,
    [activeModelId, models],
  );
  const terrainFieldForPlacement = useParcelBaseStore((s) => s.terrainField);
  const parcelForPrompt = useParcelBaseStore((s) => s.parcel);
  const terrainSourceForPrompt = useParcelBaseStore((s) => s.terrainSource);
  const terrainFieldForPrompt = useParcelBaseStore((s) => s.terrainField);
  const activePlacement = activeModel?.placement ?? ZERO_PLACEMENT;
  const activeModelStatus = activeModel?.analysisStatus ?? "queued";

  const parcelContextForPrompt = useMemo(() => {
    if (!parcelForPrompt) return undefined;
    let rangeM: number | null = null;
    if (terrainFieldForPrompt?.heights?.length) {
      const min = Math.min(...terrainFieldForPrompt.heights);
      const max = Math.max(...terrainFieldForPrompt.heights);
      rangeM = Number.isFinite(min) && Number.isFinite(max) ? Math.max(0, max - min) : null;
    }
    return {
      cadNum: parcelForPrompt.cadNum,
      specifiedAreaM2: parcelForPrompt.specifiedAreaM2,
      fitRadiusM: parcelForPrompt.fitRadiusM,
      hasTerrain: Boolean(terrainFieldForPrompt),
      terrainSource: terrainSourceForPrompt,
      terrainElevationRangeM: rangeM,
    };
  }, [parcelForPrompt, terrainFieldForPrompt, terrainSourceForPrompt]);

  const [draftPlacement, setDraftPlacement] = useState<IfcModelItem["placement"]>(activePlacement);
  const draftPlacementRef = useRef(draftPlacement);
  useEffect(() => {
    draftPlacementRef.current = draftPlacement;
  }, [draftPlacement]);
  useEffect(() => {
    setDraftPlacement(activePlacement);
    dragStateRef.current = null;
    setIsTransforming(false);
    setCanvasGesture(null);
    setPointerOverMovePlane(false);
    setIsSelected(Boolean(activeModelId && activeModel?.isPlaced));
  }, [activeModel?.isPlaced, activePlacement, activeModelId]);

  useEffect(() => {
    const el = canvasElementRef.current;
    if (!el) return;
    if (canvasGesture === "move") {
      el.style.cursor = CURSOR_TABLER_ARROWS_MAXIMIZE;
      return;
    }
    if (canvasGesture === "rotate") {
      el.style.cursor = CURSOR_TABLER_ROTATE_360;
      return;
    }
    if (hoveredRotateHandleKey) {
      el.style.cursor = CURSOR_TABLER_ROTATE_360;
      return;
    }
    if (transformMode === "translate" && pointerOverMovePlane) {
      el.style.cursor = CURSOR_TABLER_ARROWS_MAXIMIZE;
      return;
    }
    el.style.cursor = "";
  }, [canvasGesture, hoveredRotateHandleKey, transformMode, pointerOverMovePlane]);

  const activeGeometryEntry = useMemo(() => {
    if (!activeModelId || !activeModel?.isPlaced || activeModelStatus !== "ready") return null;
    const cached = cache.get(geometryCacheKey(activeModel));
    return cached ?? null;
  }, [activeModel, activeModelId, activeModelStatus, cache]);

  const activeObject = activeGeometryEntry?.object ?? null;

  const resolvePlacementY = useCallback(
    (
      placement: IfcModelItem["placement"],
      object: THREE.Group | null,
      bounds: ModelBounds | null,
    ): number => {
      if (!terrainFieldForPlacement || !object || !bounds) return placement.y;
      const probe = { ...placement, y: 0 };
      const footprint = computeWorldFootprintFromObject(object, bounds, probe);
      let maxTerrainY = Number.NEGATIVE_INFINITY;
      const [c0, c1, c2, c3] = footprint.corners;
      const center = {
        x: (c0.x + c1.x + c2.x + c3.x) * 0.25,
        z: (c0.z + c1.z + c2.z + c3.z) * 0.25,
      };
      const probes = [
        c0,
        c1,
        c2,
        c3,
        { x: (c0.x + c1.x) * 0.5, z: (c0.z + c1.z) * 0.5 },
        { x: (c1.x + c2.x) * 0.5, z: (c1.z + c2.z) * 0.5 },
        { x: (c2.x + c3.x) * 0.5, z: (c2.z + c3.z) * 0.5 },
        { x: (c3.x + c0.x) * 0.5, z: (c3.z + c0.z) * 0.5 },
        center,
      ];
      for (const p of probes) {
        maxTerrainY = Math.max(maxTerrainY, sampleTerrainHeight(terrainFieldForPlacement, p.x, p.z));
      }
      if (!Number.isFinite(maxTerrainY)) return placement.y;
      const bottomOffsetY = footprint.minY;
      return maxTerrainY + TERRAIN_WORLD_Y_OFFSET - bottomOffsetY + MODEL_TERRAIN_CLEARANCE_M;
    },
    [terrainFieldForPlacement],
  );

  const keepPlacementAboveTerrain = useCallback(
    (
      placement: IfcModelItem["placement"],
      object: THREE.Group | null,
      bounds: ModelBounds | null,
    ): IfcModelItem["placement"] => {
      const minY = resolvePlacementY(placement, object, bounds);
      if (!Number.isFinite(minY) || placement.y >= minY) return placement;
      return { ...placement, y: minY };
    },
    [resolvePlacementY],
  );

  useEffect(() => {
    if (!terrainFieldForPlacement || isTransforming) return;
    for (const model of models) {
      if (!model.isPlaced || model.analysisStatus !== "ready") continue;
      const entry = cache.get(geometryCacheKey(model));
      if (!entry) continue;
      const nextY = resolvePlacementY(model.placement, entry.object, entry.bounds);
      if (!Number.isFinite(nextY)) continue;
      // Автопосадка только «поднимает» объект, но не опускает ручную подстройку по Y.
      if (model.placement.y >= nextY - 0.005) continue;
      onPlacementCommit(model.id, { ...model.placement, y: nextY });
    }
  }, [cache, isTransforming, models, onPlacementCommit, resolvePlacementY, terrainFieldForPlacement]);

  useEffect(() => {
    const readyModels = models.filter((item) => item.isPlaced && item.analysisStatus === "ready");
    const groupedByGeometryKey = new Map<string, IfcModelItem[]>();
    for (const item of readyModels) {
      const key = geometryCacheKey(item);
      const group = groupedByGeometryKey.get(key);
      if (group) {
        group.push(item);
      } else {
        groupedByGeometryKey.set(key, [item]);
      }
    }

    const validKeys = new Set(groupedByGeometryKey.keys());
    for (const [key, controller] of loadingControllersRef.current) {
      if (validKeys.has(key)) continue;
      controller.abort();
      loadingControllersRef.current.delete(key);
      loadingKeysRef.current.delete(key);
      progressUpdatesRef.current.delete(key);
    }

    setCache((previous) => {
      let changed = false;
      const next = new Map<string, CacheEntry>();
      for (const [key, entry] of previous) {
        if (validKeys.has(key)) {
          next.set(key, entry);
          continue;
        }
        disposeObjectResources(entry.object);
        changed = true;
      }
      return changed ? next : previous;
    });

    for (const [key, groupedModels] of groupedByGeometryKey) {
      const cacheEntry = cache.get(key);
      if (cacheEntry) {
        for (const model of groupedModels) {
          if (model.geometryStatus !== "ready") onGeometryReady(model.id, cacheEntry.stats);
        }
        continue;
      }

      if (loadingKeysRef.current.has(key)) continue;

      const controller = new AbortController();
      loadingKeysRef.current.add(key);
      loadingControllersRef.current.set(key, controller);

      for (const model of groupedModels) onGeometryLoading(model.id);
      setProgressById((previous) => {
        const next = { ...previous };
        for (const model of groupedModels) next[model.id] = 0;
        return next;
      });

      const sourceModel = groupedModels[0];
      void (async () => {
        try {
          const result = await loadIfcGeometry(sourceModel.file, {
            signal: controller.signal,
            onProgress: (value) => {
              const now = performance.now();
              const lastUpdate = progressUpdatesRef.current.get(key);
              if (
                value < 1 &&
                lastUpdate &&
                now - lastUpdate.at < 80 &&
                Math.abs(value - lastUpdate.value) < 0.02
              ) {
                return;
              }
              progressUpdatesRef.current.set(key, { at: now, value });

              setProgressById((previous) => {
                let changed = false;
                const next = { ...previous };
                for (const model of groupedModels) {
                  if (next[model.id] === value) continue;
                  next[model.id] = value;
                  changed = true;
                }
                return changed ? next : previous;
              });
            },
          });

          if (controller.signal.aborted) return;

          setCache((previous) => {
            const next = new Map(previous);
            next.set(key, {
              object: result.group,
              stats: result.stats,
              bounds: updateSelectionBounds(result.group),
            });
            return next;
          });

          for (const model of groupedModels) {
            onGeometryReady(model.id, result.stats);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : "IFC geometry build failed.";
          for (const model of groupedModels) {
            onGeometryError(model.id, message);
          }
        } finally {
          loadingKeysRef.current.delete(key);
          loadingControllersRef.current.delete(key);
          progressUpdatesRef.current.delete(key);
        }
      })();
    }
  }, [cache, models, onGeometryError, onGeometryLoading, onGeometryReady]);

  useEffect(
    () => () => {
      for (const controller of loadingControllersRef.current.values()) {
        controller.abort();
      }
      loadingControllersRef.current.clear();
      loadingKeysRef.current.clear();
      progressUpdatesRef.current.clear();
      for (const entry of cacheRef.current.values()) {
        disposeObjectResources(entry.object);
      }
      cacheRef.current.clear();
      instanceObjectsRef.current.clear();
    },
    [],
  );

  const commitPlacement = useCallback(() => {
    if (!activeModelId) return;
    const nextPlacement: IfcModelItem["placement"] = {
      x: draftPlacementRef.current.x,
      y: draftPlacementRef.current.y,
      z: draftPlacementRef.current.z,
      rotationY: normalizeAngle(draftPlacementRef.current.rotationY),
    };
    const stabilized = keepPlacementAboveTerrain(
      nextPlacement,
      activeObject,
      activeGeometryEntry?.bounds ?? null,
    );
    setDraftPlacement(stabilized);
    draftPlacementRef.current = stabilized;
    onPlacementCommit(activeModelId, stabilized);
  }, [activeGeometryEntry?.bounds, activeModelId, activeObject, keepPlacementAboveTerrain, onPlacementCommit]);

  const setCameraControlsEnabled = useCallback((enabled: boolean) => {
    if (controlsRef.current) controlsRef.current.enabled = enabled;
  }, []);

  const beginMoveDrag = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (!activeModelId) return;
      const point = getGroundPointFromEvent(event);
      if (!point) return;

      event.stopPropagation();
      const currentTarget = event.currentTarget as EventTarget & {
        setPointerCapture?: (pointerId: number) => void;
      };
      currentTarget.setPointerCapture?.(event.pointerId);

      const placement = draftPlacementRef.current;
      dragStateRef.current = {
        type: "move",
        pointerId: event.pointerId,
        offsetX: point.x - placement.x,
        offsetZ: point.z - placement.z,
      };

      setCanvasGesture("move");
      setCameraControlsEnabled(false);
      setIsTransforming(true);
      setIsSelected(true);
    },
    [activeModelId, setCameraControlsEnabled],
  );

  const beginRotateDrag = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (!activeModelId) return;
      const point = getGroundPointFromEvent(event);
      if (!point) return;

      event.stopPropagation();
      const currentTarget = event.currentTarget as EventTarget & {
        setPointerCapture?: (pointerId: number) => void;
      };
      currentTarget.setPointerCapture?.(event.pointerId);

      const placement = draftPlacementRef.current;
      const startAngle = Math.atan2(point.z - placement.z, point.x - placement.x);

      dragStateRef.current = {
        type: "rotate",
        pointerId: event.pointerId,
        centerX: placement.x,
        centerZ: placement.z,
        startAngle,
        startRotation: placement.rotationY,
      };

      setCanvasGesture("rotate");
      setCameraControlsEnabled(false);
      setIsTransforming(true);
      setIsSelected(true);
    },
    [activeModelId, setCameraControlsEnabled],
  );

  const applyAlignmentSnap = useCallback((placement: IfcModelItem["placement"]) => {
    const data = alignmentSnapRef.current;
    if (!data) return placement;

    let x = placement.x;
    let z = placement.z;

    let bestXDelta = 0;
    let bestXDistance = ALIGNMENT_SNAP_DISTANCE;
    for (const activeEdge of [
      { edge: "left", value: x + data.activeOffsets.minX },
      { edge: "right", value: x + data.activeOffsets.maxX },
    ] satisfies AlignmentSnapTarget[]) {
      for (const target of data.xTargets) {
        const delta = target.value - activeEdge.value;
        const distance = Math.abs(delta);
        if (distance >= bestXDistance) continue;
        bestXDistance = distance;
        bestXDelta = delta;
      }
    }
    x += bestXDelta;

    let bestZDelta = 0;
    let bestZDistance = ALIGNMENT_SNAP_DISTANCE;
    for (const activeEdge of [
      { edge: "top", value: z + data.activeOffsets.minZ },
      { edge: "bottom", value: z + data.activeOffsets.maxZ },
    ] satisfies AlignmentSnapTarget[]) {
      for (const target of data.zTargets) {
        const delta = target.value - activeEdge.value;
        const distance = Math.abs(delta);
        if (distance >= bestZDistance) continue;
        bestZDistance = distance;
        bestZDelta = delta;
      }
    }
    z += bestZDelta;

    if (x === placement.x && z === placement.z) return placement;
    return { ...placement, x, z };
  }, []);

  const applyParallelFaceMagnetToPlacement = useCallback(
    (placement: IfcModelItem["placement"]): IfcModelItem["placement"] => {
      if (!activeModelId) return placement;
      const list = sceneModelsRef.current;
      const entry = list.find((s) => s.model.id === activeModelId);
      if (!entry) return placement;
      const { corners } = computeWorldFootprintFromObject(entry.object, entry.bounds, placement);
      const otherFootprints: ModelGroundFootprint[] = [];
      for (const s of list) {
        if (s.model.id === activeModelId) continue;
        const p = s.model.placement;
        const o = computeWorldFootprintFromObject(s.object, s.bounds, p);
        otherFootprints.push({
          id: s.model.id,
          center: { x: p.x, z: p.z },
          corners: o.corners,
          minY: o.minY,
          maxY: o.maxY,
        });
      }
      const delta = computeParallelFaceMagnetDelta(corners, otherFootprints);
      if (!delta) return placement;
      return {
        ...placement,
        x: placement.x + delta.dx,
        z: placement.z + delta.dz,
      };
    },
    [activeModelId],
  );

  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const point = getGroundPointFromEvent(event);
    if (!point) return;

    event.stopPropagation();

    if (drag.type === "move") {
      const desiredX = point.x - drag.offsetX;
      const desiredZ = point.z - drag.offsetZ;
      setDraftPlacement((previous) => {
        const dx = desiredX - previous.x;
        const dz = desiredZ - previous.z;
        const nextDx =
          Math.abs(dx) < MOVE_DRAG_DEAD_ZONE
            ? 0
            : THREE.MathUtils.clamp(
                dx * MOVE_DRAG_SENSITIVITY,
                -MOVE_DRAG_MAX_STEP,
                MOVE_DRAG_MAX_STEP,
              );
        const nextDz =
          Math.abs(dz) < MOVE_DRAG_DEAD_ZONE
            ? 0
            : THREE.MathUtils.clamp(
                dz * MOVE_DRAG_SENSITIVITY,
                -MOVE_DRAG_MAX_STEP,
                MOVE_DRAG_MAX_STEP,
              );

        if (nextDx === 0 && nextDz === 0) return previous;
        let next = applyAlignmentSnap({
          ...previous,
          x: previous.x + nextDx,
          y: previous.y,
          z: previous.z + nextDz,
        });
        next = applyParallelFaceMagnetToPlacement(next);
        next = keepPlacementAboveTerrain(next, activeObject, activeGeometryEntry?.bounds ?? null);
        return next;
      });
    } else {
      const angle = Math.atan2(point.z - drag.centerZ, point.x - drag.centerX);
      const delta = normalizeAngle(angle - drag.startAngle);
      let desiredRotation = normalizeAngle(
        drag.startRotation - delta * ROTATE_DRAG_SENSITIVITY,
      );
      if (rotationSnapEnabled) {
        desiredRotation = snapAngle(
          desiredRotation,
          THREE.MathUtils.degToRad(rotationSnapStepDegrees),
        );
      }
      setDraftPlacement((previous) => {
        const shortest = normalizeAngle(desiredRotation - previous.rotationY);
        if (Math.abs(shortest) < ROTATE_DRAG_DEAD_ZONE) return previous;
        let next: IfcModelItem["placement"] = {
          ...previous,
          rotationY: desiredRotation,
        };
        if (activeModelId) {
          next = applyParallelEdgeRotationSnap(next, activeModelId, sceneModelsRef.current);
        }
        next = keepPlacementAboveTerrain(next, activeObject, activeGeometryEntry?.bounds ?? null);
        return next;
      });
    }
  }, [
    activeModelId,
    applyAlignmentSnap,
    applyParallelFaceMagnetToPlacement,
    activeGeometryEntry?.bounds,
    activeObject,
    keepPlacementAboveTerrain,
    rotationSnapEnabled,
    rotationSnapStepDegrees,
  ]);

  const endDrag = useCallback((event: ThreeEvent<PointerEvent>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    const currentTarget = event.currentTarget as EventTarget & {
      releasePointerCapture?: (pointerId: number) => void;
    };
    currentTarget.releasePointerCapture?.(event.pointerId);

    dragStateRef.current = null;
    setCanvasGesture(null);
    setIsTransforming(false);
    setCameraControlsEnabled(true);
    commitPlacement();
  }, [commitPlacement, setCameraControlsEnabled]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(MODEL_DND_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleDropModel = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const droppedModelId = event.dataTransfer.getData(MODEL_DND_MIME).trim();
      if (!droppedModelId) return;

      event.preventDefault();
      event.stopPropagation();

      const model = models.find((item) => item.id === droppedModelId);
      if (!model) return;

      const camera = cameraRef.current;
      const canvasElement = canvasElementRef.current;
      const cacheEntry = cache.get(geometryCacheKey(model));
      if (!camera || !canvasElement) {
        const fallbackPlacement: IfcModelItem["placement"] = {
          x: model.placement.x,
          y: model.placement.y,
          z: model.placement.z,
          rotationY: model.placement.rotationY,
        };
        const minY = resolvePlacementY(
          fallbackPlacement,
          cacheEntry?.object ?? null,
          cacheEntry?.bounds ?? null,
        );
        const placedModelId = onDropModel(droppedModelId, {
          x: fallbackPlacement.x,
          y: Math.max(fallbackPlacement.y, minY),
          z: fallbackPlacement.z,
          rotationY: model.placement.rotationY,
        });
        if (placedModelId) onSelectModel(placedModelId);
        setIsSelected(Boolean(placedModelId));
        return;
      }

      const rect = canvasElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycasterRef.current.setFromCamera(ndc, camera);

      const point = new THREE.Vector3();
      const hit = raycasterRef.current.ray.intersectPlane(GROUND_PLANE, point);
      const probePlacement: IfcModelItem["placement"] = {
        x: hit ? point.x : model.placement.x,
        y: model.placement.y,
        z: hit ? point.z : model.placement.z,
        rotationY: model.placement.rotationY,
      };
      const minY = resolvePlacementY(
        probePlacement,
        cacheEntry?.object ?? null,
        cacheEntry?.bounds ?? null,
      );

      const placedModelId = onDropModel(droppedModelId, {
        x: probePlacement.x,
        y: Math.max(probePlacement.y, minY),
        z: probePlacement.z,
        rotationY: model.placement.rotationY,
      });
      if (placedModelId) onSelectModel(placedModelId);
      setIsSelected(Boolean(placedModelId));
    },
    [cache, models, onDropModel, onSelectModel, resolvePlacementY],
  );

  const selectionBounds = useMemo(() => {
    return activeGeometryEntry?.bounds ?? null;
  }, [activeGeometryEntry]);

  const cornerHandles = useMemo(() => {
    if (!selectionBounds) return [] as Array<[number, number, number]>;
    const { minX, maxX, minZ, maxZ, minY } = selectionBounds;
    return [
      [minX, minY, minZ],
      [maxX, minY, minZ],
      [maxX, minY, maxZ],
      [minX, minY, maxZ],
    ];
  }, [selectionBounds]);

  const rotateHandleInnerRadius = useMemo(() => {
    if (!selectionBounds) return 0.55;
    const width = Math.max(selectionBounds.maxX - selectionBounds.minX, 1);
    const depth = Math.max(selectionBounds.maxZ - selectionBounds.minZ, 1);
    const span = Math.max(width, depth);
    return THREE.MathUtils.clamp(span * 0.045, 0.55, 1.3);
  }, [selectionBounds]);

  const rotateHandleThickness = useMemo(() => {
    return THREE.MathUtils.clamp(rotateHandleInnerRadius * 0.32, 0.18, 0.36);
  }, [rotateHandleInnerRadius]);

  const sceneModels = useMemo(
    () => {
      const validInstanceIds = new Set<string>();

      const list = models
        .map((item) => {
          const geometryKey = geometryCacheKey(item);
          const entry = cache.get(geometryKey);
          if (!item.isPlaced) return null;
          if (!entry || item.analysisStatus !== "ready") return null;

          validInstanceIds.add(item.id);
          const existing = instanceObjectsRef.current.get(item.id);
          if (existing && existing.geometryKey === geometryKey) {
            return { model: item, object: existing.object, bounds: entry.bounds };
          }

          const instanceObject = entry.object.clone(true);
          instanceObjectsRef.current.set(item.id, {
            geometryKey,
            object: instanceObject,
          });
          return { model: item, object: instanceObject, bounds: entry.bounds };
        })
        .filter(
          (
            value,
          ): value is { model: IfcModelItem; object: THREE.Group; bounds: ModelBounds } =>
            Boolean(value),
        );

      for (const [instanceId] of instanceObjectsRef.current) {
        if (validInstanceIds.has(instanceId)) continue;
        instanceObjectsRef.current.delete(instanceId);
      }

      return list;
    },
    [cache, models],
  );
  sceneModelsRef.current = sceneModels;

  const sceneGroundFootprints = useMemo(() => {
    return sceneModels
      .map(({ model: sceneModel, bounds, object }) => {
        const placement = activeModelId === sceneModel.id ? draftPlacement : sceneModel.placement;
        const { corners, minY, maxY } = computeWorldFootprintFromObject(object, bounds, placement);

        return {
          id: sceneModel.id,
          center: { x: placement.x, z: placement.z },
          corners,
          minY,
          maxY,
        } satisfies ModelGroundFootprint;
      })
      .filter((value): value is ModelGroundFootprint => Boolean(value));
  }, [activeModelId, draftPlacement, sceneModels]);

  const activeGroundFootprint = useMemo(
    () => sceneGroundFootprints.find((item) => item.id === activeModelId) ?? null,
    [activeModelId, sceneGroundFootprints],
  );

  /** Центр кластера следов на земле — от него выносим отладочные панели «наружу». */
  const sceneDebugRadialOrigin = useMemo((): { x: number; z: number } | null => {
    if (sceneGroundFootprints.length === 0) return null;
    let sx = 0;
    let sz = 0;
    for (const fp of sceneGroundFootprints) {
      const e = getFootprintExtents(fp);
      sx += (e.minX + e.maxX) * 0.5;
      sz += (e.minZ + e.maxZ) * 0.5;
    }
    const n = sceneGroundFootprints.length;
    return { x: sx / n, z: sz / n };
  }, [sceneGroundFootprints]);

  const [debugCalloutPixelOffsets, setDebugCalloutPixelOffsets] = useState<
    Record<string, { x: number; y: number }>
  >({});

  const shiftDebugCalloutPixels = useCallback((id: string, dx: number, dy: number) => {
    setDebugCalloutPixelOffsets((prev) => ({
      ...prev,
      [id]: { x: (prev[id]?.x ?? 0) + dx, y: (prev[id]?.y ?? 0) + dy },
    }));
  }, []);

  useEffect(() => {
    if (!activeModelId || !activeGroundFootprint) {
      alignmentSnapRef.current = null;
      return;
    }

    const activeExtents = getFootprintExtents(activeGroundFootprint);
    const xTargets: AlignmentSnapTarget[] = [];
    const zTargets: AlignmentSnapTarget[] = [];

    for (const footprint of sceneGroundFootprints) {
      if (footprint.id === activeModelId) continue;
      const extents = getFootprintExtents(footprint);
      xTargets.push(
        { edge: "left", value: extents.minX },
        { edge: "right", value: extents.maxX },
      );
      zTargets.push(
        { edge: "top", value: extents.minZ },
        { edge: "bottom", value: extents.maxZ },
      );
    }

    alignmentSnapRef.current = {
      activeOffsets: {
        minX: activeExtents.minX - activeGroundFootprint.center.x,
        maxX: activeExtents.maxX - activeGroundFootprint.center.x,
        minZ: activeExtents.minZ - activeGroundFootprint.center.z,
        maxZ: activeExtents.maxZ - activeGroundFootprint.center.z,
      },
      xTargets,
      zTargets,
    };
  }, [activeGroundFootprint, activeModelId, sceneGroundFootprints]);

  const proximityHatchAreas = useMemo(() => {
    if (!activeModelId || !activeGroundFootprint) {
      return [] as ProximityHatchArea[];
    }
    if (!PROXIMITY_HATCH_ALWAYS_ON && !isTransforming) {
      return [] as ProximityHatchArea[];
    }

    const activeEdges = getFootprintEdgeSegments(activeGroundFootprint.corners);

    return sceneGroundFootprints
      .filter((footprint) => footprint.id !== activeModelId)
      .map((footprint) => {
        const otherEdges = getFootprintEdgeSegments(footprint.corners);
        const candidates: Array<{
          distSq: number;
          source: GroundSegment;
          target: GroundSegment;
        }> = [];

        for (const source of activeEdges) {
          for (const target of otherEdges) {
            const bridgeSeg = closestPointsOnSegments2D(
              source.start,
              source.end,
              target.start,
              target.end,
            );
            candidates.push({ distSq: bridgeSeg.distanceSq, source, target });
          }
        }
        candidates.sort((a, b) => a.distSq - b.distSq);

        // Идём по возрастанию зазора. Первая же пара, для которой рёбра параллельны и строится полоса —
        // это ближайшая «осмысленная» пара (параллельные грани). Сама по себе минимальная дистанция
        // между отрезками часто даёт угол–ребро (не параллельно) — тогда без следующих кандидатов
        // зона никогда не появится при визуально параллельных фасадах.
        for (const { distSq, source, target } of candidates) {
          const gap = Math.sqrt(distSq);
          if (gap > PROXIMITY_HATCH_DISTANCE) break;
          if (gap <= 1e-6) continue;
          if (getParallelDelta(source, target) > PROXIMITY_HATCH_EDGE_TOLERANCE) continue;

          const bridgePts = closestPointsOnSegments2D(
            source.start,
            source.end,
            target.start,
            target.end,
          );
          const gdx = bridgePts.b.x - bridgePts.a.x;
          const gdz = bridgePts.b.z - bridgePts.a.z;
          const sdx = source.end.x - source.start.x;
          const sdz = source.end.z - source.start.z;
          const slen = Math.hypot(sdx, sdz);
          if (slen < 1e-9) continue;
          const ux = sdx / slen;
          const uz = sdz / slen;
          const alongEdge = Math.abs(gdx * ux + gdz * uz);
          if (alongEdge > 0.2 * gap + 1e-7) continue;

          const area = buildProximityHatchAreaForPair(
            source,
            target,
            `${activeModelId}:${footprint.id}:${source.edge}:${target.edge}:hatch`,
          );
          if (!area) continue;
          return {
            ...area,
            sourceModelId: activeModelId,
            targetModelId: footprint.id,
          };
        }

        return null;
      })
      .filter((area): area is ProximityHatchArea => Boolean(area));
  }, [activeGroundFootprint, activeModelId, isTransforming, sceneGroundFootprints]);

  const alignmentPlaneHint = useMemo(() => {
    if (!activeModelId || !activeGroundFootprint || !isTransforming) {
      return null as AlignmentPlaneHint | null;
    }

    const activeEdges = getFootprintEdgeSegments(activeGroundFootprint.corners);
    let bestHint: AlignmentPlaneHint | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const footprint of sceneGroundFootprints) {
      if (footprint.id === activeModelId) continue;

      for (const source of activeEdges) {
        for (const target of getFootprintEdgeSegments(footprint.corners)) {
          if (getParallelDelta(source, target) > PARALLEL_EDGE_TOLERANCE) continue;
          const lineDistance = getParallelLineDistance(source, target);
          if (lineDistance > EDGE_ALIGNMENT_TOLERANCE) continue;

          const closest = closestPointsOnSegments2D(
            source.start,
            source.end,
            target.start,
            target.end,
          );
          const score = lineDistance + closest.distanceSq * 0.001;
          if (score >= bestScore) continue;

          bestScore = score;
          bestHint = {
            id: `${activeModelId}:${footprint.id}:${source.edge}:${target.edge}`,
            source,
            target,
            spanPoints: [...activeGroundFootprint.corners, ...footprint.corners],
            minY: Math.min(activeGroundFootprint.minY, footprint.minY),
            maxY: Math.max(activeGroundFootprint.maxY, footprint.maxY),
          };
        }
      }

      for (const target of getFootprintEdgeSegments(footprint.corners)) {
        activeGroundFootprint.corners.forEach((corner, cornerIndex) => {
          const projection = getPointLineProjection(corner, target);
          if (!projection || projection.distance > EDGE_ALIGNMENT_TOLERANCE) return;

          const source = buildProjectedPointSegment(corner, target);
          if (!source) return;

          const projectionGap = Math.max(
            0,
            -projection.projection,
            projection.projection - projection.length,
          );
          const score = projection.distance + projectionGap * 0.001;
          if (score >= bestScore) return;

          bestScore = score;
          bestHint = {
            id: `${activeModelId}:${footprint.id}:corner-${cornerIndex}:${target.edge}`,
            source,
            target,
            spanPoints: [...activeGroundFootprint.corners, ...footprint.corners],
            minY: Math.min(activeGroundFootprint.minY, footprint.minY),
            maxY: Math.max(activeGroundFootprint.maxY, footprint.maxY),
          };
        });
      }
    }

    return bestHint;
  }, [activeGroundFootprint, activeModelId, isTransforming, sceneGroundFootprints]);

  const rotateParallelEdgeHighlight = useMemo(() => {
    if (!isTransforming || canvasGesture !== "rotate" || !activeModelId) return null;
    if (sceneGroundFootprints.length < 2) return null;

    const activeFootprint = sceneGroundFootprints.find((item) => item.id === activeModelId);
    if (!activeFootprint) return null;

    const activeEdges = getFootprintEdgeSegments(activeFootprint.corners);
    const candidates: Array<{ distSq: number; sa: GroundSegment; sb: GroundSegment }> = [];

    for (const other of sceneGroundFootprints) {
      if (other.id === activeModelId) continue;
      const otherEdges = getFootprintEdgeSegments(other.corners);
      for (const sa of activeEdges) {
        for (const sb of otherEdges) {
          const bridge = closestPointsOnSegments2D(sa.start, sa.end, sb.start, sb.end);
          candidates.push({ distSq: bridge.distanceSq, sa, sb });
        }
      }
    }
    candidates.sort((a, b) => a.distSq - b.distSq);
    for (const { distSq, sa, sb } of candidates) {
      if (distSq < 1e-12) continue;
      if (getParallelDelta(sa, sb) > ROTATE_PARALLEL_EDGE_HIGHLIGHT_RAD) continue;
      return { segmentA: sa, segmentB: sb };
    }
    return null;
  }, [activeModelId, canvasGesture, isTransforming, sceneGroundFootprints]);

  const measurementLines = useMemo(() => {
    if (!activeModelId || !isTransforming) return [] as MeasurementLine[];

    const activeFootprint = sceneGroundFootprints.find((item) => item.id === activeModelId);
    if (!activeFootprint) return [] as MeasurementLine[];

    const activeSegments = getFootprintSegments(activeFootprint.corners);

    return sceneGroundFootprints
      .filter((item) => item.id !== activeModelId)
      .map((otherFootprint) => {
        const otherSegments = getFootprintSegments(otherFootprint.corners);

        const overlap =
          activeFootprint.corners.some((point) => pointInConvexQuad(point, otherFootprint.corners)) ||
          otherFootprint.corners.some((point) => pointInConvexQuad(point, activeFootprint.corners));

        if (overlap) return null;

        let bestDistanceSq = Number.POSITIVE_INFINITY;
        let bestA: GroundPoint | null = null;
        let bestB: GroundPoint | null = null;

        for (const [a1, a2] of activeSegments) {
          for (const [b1, b2] of otherSegments) {
            const candidate = closestPointsOnSegments2D(a1, a2, b1, b2);
            if (candidate.distanceSq >= bestDistanceSq) continue;
            bestDistanceSq = candidate.distanceSq;
            bestA = candidate.a;
            bestB = candidate.b;
          }
        }

        if (!bestA || !bestB || !Number.isFinite(bestDistanceSq)) return null;
        const distance = Math.sqrt(bestDistanceSq);
        if (distance < 0.01) return null;

        const start: [number, number, number] = [bestA.x, 0.04, bestA.z];
        const end: [number, number, number] = [bestB.x, 0.04, bestB.z];
        const sourceCenter: [number, number, number] = [
          activeFootprint.center.x,
          0.03,
          activeFootprint.center.z,
        ];
        const targetCenter: [number, number, number] = [
          otherFootprint.center.x,
          0.03,
          otherFootprint.center.z,
        ];
        const label: [number, number, number] = [
          (start[0] + end[0]) * 0.5,
          0.11,
          (start[2] + end[2]) * 0.5,
        ];

        return {
          id: `${activeFootprint.id}:${otherFootprint.id}`,
          start,
          end,
          sourceCenter,
          targetCenter,
          label,
          distance,
        } satisfies MeasurementLine;
      })
      .filter((value): value is MeasurementLine => Boolean(value));
  }, [activeModelId, isTransforming, sceneGroundFootprints]);

  const overlayText = useMemo(() => {
    const placedCount = models.reduce((count, item) => count + (item.isPlaced ? 1 : 0), 0);
    if (models.length === 0) return "Загрузите IFC-файлы.";
    if (placedCount === 0) return "Перетащите модель из левой панели на сцену.";
    if (!activeModel) return "Выберите модель в библиотеке.";
    if (!activeModel.isPlaced) return "Перетащите выбранную модель на сцену.";
    if (activeModel.analysisStatus === "queued") return "Модель в очереди на анализ...";
    if (activeModel.analysisStatus === "analyzing") return "Идёт анализ IFC...";
    if (activeModel.analysisStatus === "error") {
      return activeModel.analysisError ?? "Analysis failed.";
    }
    if (activeModel.geometryStatus === "loading") {
      const progress = progressById[activeModel.id] ?? 0;
      return `Построение геометрии... ${Math.round(progress * 100)}%`;
    }
    if (activeModel.geometryStatus === "error") {
      return activeModel.geometryError ?? "Ошибка построения геометрии.";
    }
    if (!activeObject) return "Подготовка сцены...";
    return null;
  }, [activeModel, activeObject, models, progressById]);

  const rotateHandleColor = SELECTION_ACCENT_COLOR;

  const [nanoBananaFeedback, setNanoBananaFeedback] = useState<string | null>(null);
  const [viewportSnapshotFeedback, setViewportSnapshotFeedback] = useState<string | null>(null);

  const nanoBananaArchitecturalModels = useMemo(() => {
    const out: ReturnType<typeof buildArchitecturalModelDetail>[] = [];
    for (const m of models) {
      if (!m.isPlaced) continue;
      const placement = m.id === activeModelId && draftPlacement ? draftPlacement : m.placement;
      const key = geometryCacheKey(m);
      const entry = cache.get(key);
      if (!entry) continue;
      const fp = computeWorldFootprintFromObject(entry.object, entry.bounds, placement);
      out.push(buildArchitecturalModelDetail(m, placement, fp, entry.bounds));
    }
    return out;
  }, [models, activeModelId, draftPlacement, cache]);

  const handleCopyNanoBananaPrompt = useCallback(async () => {
    const canvas = canvasElementRef.current;
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    const placedModels = collectPlacedModelSnapshots(models, {
      activeModelId,
      draftPlacement,
    });
    const w = canvas?.clientWidth ?? 0;
    const h = canvas?.clientHeight ?? 0;

    if (!cam || cam.type !== "PerspectiveCamera" || !controls || !canvas) {
      const json = buildNanoBananaPromptJson({
        promptProfile: workspaceMode,
        viewMode,
        camera: null,
        canvasCssWidth: w,
        canvasCssHeight: h,
        placedModels,
        architecturalModels: nanoBananaArchitecturalModels,
        parcelContext: parcelContextForPrompt,
        error: "Камера или canvas не готовы — подождите загрузку сцены.",
      });
      try {
        await navigator.clipboard.writeText(json);
        setNanoBananaFeedback("JSON скопирован (без параметров камеры)");
      } catch {
        setNanoBananaFeedback("Не удалось скопировать");
      }
      setTimeout(() => setNanoBananaFeedback(null), 3200);
      return;
    }

    const p = cam as THREE.PerspectiveCamera;
    const tgt = controls.target;
    const cameraSnapshot = {
      position: [p.position.x, p.position.y, p.position.z] as [number, number, number],
      target: [tgt.x, tgt.y, tgt.z] as [number, number, number],
      up: [p.up.x, p.up.y, p.up.z] as [number, number, number],
      quaternion: p.quaternion.toArray() as [number, number, number, number],
      fovDeg: THREE.MathUtils.radToDeg(p.fov),
      aspect: p.aspect,
      near: p.near,
      far: p.far,
      zoom: p.zoom,
    };

    const json = buildNanoBananaPromptJson({
      promptProfile: workspaceMode,
      viewMode,
      camera: cameraSnapshot,
      canvasCssWidth: w,
      canvasCssHeight: h,
      placedModels,
      architecturalModels: nanoBananaArchitecturalModels,
      parcelContext: parcelContextForPrompt,
    });
    try {
      await navigator.clipboard.writeText(json);
      setNanoBananaFeedback("JSON для NanoBanana скопирован");
    } catch {
      setNanoBananaFeedback("Не удалось скопировать");
    }
    setTimeout(() => setNanoBananaFeedback(null), 3200);
  }, [activeModelId, draftPlacement, models, nanoBananaArchitecturalModels, parcelContextForPrompt, viewMode, workspaceMode]);

  const handleCopyViewportSnapshot = useCallback(async () => {
    const gl = glRef.current;
    const scene = sceneRef.current;
    const cam = cameraRef.current;
    const canvas = canvasElementRef.current;
    if (!gl || !scene || !cam || !canvas) {
      setViewportSnapshotFeedback("Сцена не готова");
      setTimeout(() => setViewportSnapshotFeedback(null), 3200);
      return;
    }

    try {
      controlsRef.current?.update();
      gl.render(scene, cam);
      await new Promise((r) => requestAnimationFrame(r));

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else reject(new Error("toBlob"));
          },
          "image/png",
          0.94,
        );
      });

      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setViewportSnapshotFeedback("Изображение скопировано в буфер");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `gravio-viewport-${Date.now()}.png`;
        a.rel = "noopener";
        a.click();
        URL.revokeObjectURL(url);
        setViewportSnapshotFeedback("Скачано PNG (буфер изображений недоступен)");
      }
    } catch {
      setViewportSnapshotFeedback("Не удалось получить снимок");
    }
    setTimeout(() => setViewportSnapshotFeedback(null), 3200);
  }, []);

  return (
    <div
      className="relative h-full w-full bg-[#9fbfcf]"
      onDragOver={handleDragOver}
      onDrop={handleDropModel}
    >
      <Canvas
        dpr={[1, 1.5]}
        frameloop="demand"
        camera={{ position: [15, 12, 15], fov: 45, near: 0.1, far: 20000 }}
        gl={{
          antialias: true,
          powerPreference: "high-performance",
          preserveDrawingBuffer: true,
        }}
        onCreated={({ camera, gl, scene }) => {
          cameraRef.current = camera;
          glRef.current = gl;
          sceneRef.current = scene;
          canvasElementRef.current = gl.domElement;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = VIEWPORT_OUTDOOR_SPEC.renderer.toneMappingExposure;
        }}
        onPointerMissed={() => {
          if (!dragStateRef.current) {
            setIsSelected(false);
            setPointerOverMovePlane(false);
          }
        }}
      >
        <OutdoorGroundEnvironment />
        <CadastreParcelLayer />

        {sceneModels.map(({ model: sceneModel, object, bounds }) => {
          const isActive = activeModelId === sceneModel.id;
          const placement = isActive ? draftPlacement : sceneModel.placement;

          return (
            <group
              key={sceneModel.id}
              ref={isActive ? placementGroupRef : undefined}
              position={[placement.x, placement.y, placement.z]}
              rotation={[0, placement.rotationY, 0]}
            >
              <primitive
                object={object}
                onClick={(event: ThreeEvent<MouseEvent>) => {
                  event.stopPropagation();
                  if (!isActive) onSelectModel(sceneModel.id);
                  setIsSelected(true);
                }}
                onPointerDown={(event: ThreeEvent<PointerEvent>) => {
                  event.stopPropagation();
                  if (!isActive) {
                    onSelectModel(sceneModel.id);
                    setIsSelected(true);
                    return;
                  }
                  // В режиме translate используем 3-осевой TransformControls во вьюпорте.
                  if (transformMode !== "translate") beginMoveDrag(event);
                }}
                onPointerOver={(event: ThreeEvent<PointerEvent>) => {
                  if (!isActive || transformMode !== "translate") return;
                  event.stopPropagation();
                  setPointerOverMovePlane(true);
                }}
                onPointerOut={(event: ThreeEvent<PointerEvent>) => {
                  if (!isActive) return;
                  event.stopPropagation();
                  setPointerOverMovePlane(false);
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />

              <group
                position={[object.position.x, object.position.y, object.position.z]}
                rotation={[object.rotation.x, object.rotation.y, object.rotation.z]}
                scale={[object.scale.x, object.scale.y, object.scale.z]}
              >
                {devMode ? (
                  <NonPickableFootprintOutline
                    bounds={bounds}
                    color={ALL_MODELS_BOUNDS_OUTLINE_COLOR}
                  />
                ) : null}

                {isActive && isSelected && selectionBounds && (
                  <>
                    <NonPickableFootprintOutline
                      bounds={selectionBounds}
                      color={SELECTION_ACCENT_COLOR}
                    />

                    {cornerHandles.map((pos, index) => {
                      const handleKey = `${activeModelId ?? "no-model"}:${index}`;
                      const isMinX = pos[0] <= selectionBounds.minX + 0.0001;
                      const isMinZ = pos[2] <= selectionBounds.minZ + 0.0001;
                      const xDir: 1 | -1 = isMinX ? -1 : 1;
                      const zDir: 1 | -1 = isMinZ ? -1 : 1;
                      return (
                        <group
                          key={`rotate-${index}`}
                          position={[pos[0], pos[1] + 0.08, pos[2]]}
                        >
                          <RotateCornerHandle
                            xDir={xDir}
                            zDir={zDir}
                            color={rotateHandleColor}
                            innerRadius={rotateHandleInnerRadius}
                            thickness={rotateHandleThickness}
                            active={hoveredRotateHandleKey === handleKey}
                            onPointerDown={beginRotateDrag}
                            onPointerMove={handlePointerMove}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                            onPointerOver={(event: ThreeEvent<PointerEvent>) => {
                              event.stopPropagation();
                              setHoveredRotateHandleKey(handleKey);
                            }}
                            onPointerOut={(event: ThreeEvent<PointerEvent>) => {
                              event.stopPropagation();
                              setHoveredRotateHandleKey((current) =>
                                current === handleKey ? null : current,
                              );
                            }}
                          />
                        </group>
                      );
                    })}
                  </>
                )}
              </group>

              {devMode ? (
                <ModelDebugCallout
                  model={sceneModel}
                  bounds={bounds}
                  object={object}
                  placement={placement}
                  radialOrigin={sceneDebugRadialOrigin}
                  pixelOffset={debugCalloutPixelOffsets[sceneModel.id] ?? { x: 0, y: 0 }}
                  onPixelDragDelta={shiftDebugCalloutPixels}
                />
              ) : null}
            </group>
          );
        })}

        {transformMode === "translate" &&
        isSelected &&
        activeModelId &&
        placementGroupRef.current ? (
          <TransformControls
            object={placementGroupRef.current}
            mode="translate"
            size={0.9}
            showX
            showY
            showZ
            onObjectChange={() => {
              const g = placementGroupRef.current;
              if (!g) return;
              const nextPlacement = {
                x: g.position.x,
                y: g.position.y,
                z: g.position.z,
                rotationY: normalizeAngle(g.rotation.y),
              };
              // Важно обновить ref синхронно: commitPlacement читает именно его.
              draftPlacementRef.current = nextPlacement;
              setDraftPlacement((prev) => ({
                ...prev,
                ...nextPlacement,
              }));
            }}
            onMouseDown={() => {
              setIsTransforming(true);
              setCameraControlsEnabled(false);
            }}
            onMouseUp={() => {
              setIsTransforming(false);
              setCameraControlsEnabled(true);
              commitPlacement();
            }}
          />
        ) : null}

        {proximityHatchAreas.map((area) => (
          <ProximityHatchOverlay
            key={area.id}
            area={area}
            footprints={sceneGroundFootprints}
            radialOrigin={sceneDebugRadialOrigin}
            pixelOffset={debugCalloutPixelOffsets[area.id] ?? { x: 0, y: 0 }}
            onPixelDragDelta={shiftDebugCalloutPixels}
            showDebugCallout={devMode}
          />
        ))}

        {measurementLines.map((line) => (
          <group key={line.id}>
            <FootprintGapMeasurementVisual
              start={line.start}
              end={line.end}
              sourceCenter={line.sourceCenter}
              targetCenter={line.targetCenter}
              label={line.label}
              distance={line.distance}
            />
          </group>
        ))}

        {rotateParallelEdgeHighlight ? (
          <>
            <lineSegments renderOrder={32}>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[
                    proximitySegmentHighlightLineXZ(
                      rotateParallelEdgeHighlight.segmentA,
                      ROTATE_PARALLEL_EDGE_LINE_Y,
                    ),
                    3,
                  ]}
                />
              </bufferGeometry>
              <lineBasicMaterial
                color={PROXIMITY_HATCH_COLOR}
                depthTest
                depthWrite={false}
              />
            </lineSegments>
            <lineSegments renderOrder={32}>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[
                    proximitySegmentHighlightLineXZ(
                      rotateParallelEdgeHighlight.segmentB,
                      ROTATE_PARALLEL_EDGE_LINE_Y,
                    ),
                    3,
                  ]}
                />
              </bufferGeometry>
              <lineBasicMaterial
                color={PROXIMITY_HATCH_COLOR}
                depthTest
                depthWrite={false}
              />
            </lineSegments>
          </>
        ) : null}

        {alignmentPlaneHint && (
          <group key={alignmentPlaneHint.id}>
            <AlignmentPlaneHighlight
              maxY={alignmentPlaneHint.maxY}
              minY={alignmentPlaneHint.minY}
              source={alignmentPlaneHint.source}
              spanPoints={alignmentPlaneHint.spanPoints}
              target={alignmentPlaneHint.target}
            />
          </group>
        )}

        {viewMode === "3d" ? (
          <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            enableRotate
            minPolarAngle={0.05}
            maxPolarAngle={Math.PI / 2}
          />
        ) : (
          <MapControls
            ref={controlsRef}
            makeDefault
            enableDamping={false}
            enableRotate={false}
            screenSpacePanning
            minPolarAngle={0}
            maxPolarAngle={0}
          />
        )}

        <CameraController
          activeObject={activeObject}
          viewMode={viewMode}
          controlsRef={controlsRef}
        />
        <ViewportScaleProbe onScaleChange={setViewportScale} />
        <CadastreViewportFocus controlsRef={controlsRef} viewMode={viewMode} />
      </Canvas>

      {overlayText && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-slate-300">
          {overlayText}
        </div>
      )}

      <div className="absolute right-3 top-3 z-20 flex flex-col items-end gap-1">
        <button
          type="button"
          className="pointer-events-auto rounded-lg border border-slate-600/80 bg-slate-900/85 px-3 py-1.5 text-xs font-medium text-slate-100 shadow-md backdrop-blur-sm transition-colors hover:border-cyan-500/60 hover:bg-slate-900 hover:text-white"
          title="Скопировать детальный JSON-промпт для NanoBanana (камера 1:1, сцена, освещение)"
          onClick={() => void handleCopyNanoBananaPrompt()}
        >
          NanoBanana JSON
        </button>
        <button
          type="button"
          className="pointer-events-auto rounded-lg border border-slate-600/80 bg-slate-900/85 px-3 py-1.5 text-xs font-medium text-slate-100 shadow-md backdrop-blur-sm transition-colors hover:border-cyan-500/60 hover:bg-slate-900 hover:text-white"
          title="Снимок только 3D-сцены (без кнопок и HTML-панелей), PNG в буфер обмена"
          onClick={() => void handleCopyViewportSnapshot()}
        >
          Снимок в буфер
        </button>
        {nanoBananaFeedback ? (
          <span className="pointer-events-none max-w-[240px] rounded bg-slate-950/90 px-2 py-1 text-[11px] text-emerald-300 shadow">
            {nanoBananaFeedback}
          </span>
        ) : null}
        {viewportSnapshotFeedback ? (
          <span className="pointer-events-none max-w-[240px] rounded bg-slate-950/90 px-2 py-1 text-[11px] text-sky-300 shadow">
            {viewportSnapshotFeedback}
          </span>
        ) : null}
      </div>
      {viewportScale ? (
        <div className="pointer-events-none absolute bottom-3 right-3 z-20 rounded border border-slate-600/70 bg-slate-900/85 px-2 py-1 text-[11px] text-slate-100 shadow-md backdrop-blur-sm">
          <div className="mb-1 text-right font-medium">{formatScaleDistance(viewportScale.meters)}</div>
          <div
            className="h-[3px] rounded-full bg-white/95"
            style={{ width: `${viewportScale.pixels.toFixed(0)}px` }}
          />
        </div>
      ) : null}
    </div>
  );
}
