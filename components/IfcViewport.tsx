"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Canvas, type ThreeEvent, useThree } from "@react-three/fiber";
import { Html, MapControls, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { IfcModelItem } from "@/types/ifc";
import { loadIfcGeometry } from "@/lib/ifc/loadIfcGeometry";

interface Props {
  models: IfcModelItem[];
  activeModelId: string | null;
  viewMode: "2d" | "3d";
  transformMode: "translate" | "rotate";
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
  minY: number;
  maxY: number;
}

interface ProximityHatchArea {
  id: string;
  corners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint];
  hatchSegments: Array<[GroundPoint, GroundPoint]>;
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
const MODEL_DND_MIME = "application/x-gravio-model-id";
const ZERO_PLACEMENT: IfcModelItem["placement"] = { x: 0, y: 0, z: 0, rotationY: 0 };
const MOVE_DRAG_SENSITIVITY = 0.24;
const MOVE_DRAG_MAX_STEP = 0.45;
const MOVE_DRAG_DEAD_ZONE = 0.003;
const ROTATE_DRAG_SENSITIVITY = 1;
const ROTATE_DRAG_DEAD_ZONE = THREE.MathUtils.degToRad(0.08);
const PARALLEL_EDGE_TOLERANCE = THREE.MathUtils.degToRad(0.75);
const PROXIMITY_HATCH_EDGE_TOLERANCE = THREE.MathUtils.degToRad(3);
const ALIGNMENT_SNAP_DISTANCE = 0.35;
const EDGE_ALIGNMENT_TOLERANCE = 0.03;
const ALIGNMENT_PLANE_COLOR = "#ec4899";
const PROXIMITY_HATCH_DISTANCE = 6;
const PROXIMITY_HATCH_STEP = 0.35;
const PROXIMITY_HATCH_COLOR = "#ec4899";

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

function updateSelectionBounds(object: THREE.Group) {
  object.updateWorldMatrix(true, true);

  const parentInverse = new THREE.Matrix4();
  if (object.parent) {
    parentInverse.copy(object.parent.matrixWorld).invert();
  } else {
    parentInverse.identity();
  }

  const bounds = new THREE.Box3();
  const elementBox = new THREE.Box3();
  const elementMatrix = new THREE.Matrix4();
  let hasGeometry = false;

  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;

    const geometry = mesh.geometry;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;

    elementBox.copy(geometry.boundingBox);
    elementMatrix.multiplyMatrices(parentInverse, mesh.matrixWorld);
    elementBox.applyMatrix4(elementMatrix);

    if (!hasGeometry) {
      bounds.copy(elementBox);
      hasGeometry = true;
    } else {
      bounds.union(elementBox);
    }
  });

  if (!hasGeometry || bounds.isEmpty()) {
    return {
      minX: -1,
      maxX: 1,
      minY: 0,
      maxY: 2.5,
      minZ: -1,
      maxZ: 1,
    };
  }
  return {
    minX: bounds.min.x,
    maxX: bounds.max.x,
    minY: bounds.min.y,
    maxY: bounds.max.y,
    minZ: bounds.min.z,
    maxZ: bounds.max.z,
  };
}

function transformLocalGroundPoint(
  point: GroundPoint,
  placement: IfcModelItem["placement"],
): GroundPoint {
  const cos = Math.cos(placement.rotationY);
  const sin = Math.sin(placement.rotationY);
  return {
    x: placement.x + point.x * cos - point.z * sin,
    z: placement.z + point.x * sin + point.z * cos,
  };
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

function getParallelLineDistance(a: GroundSegment, b: GroundSegment): number {
  const dx = a.end.x - a.start.x;
  const dz = a.end.z - a.start.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return Number.POSITIVE_INFINITY;
  return Math.abs((b.start.x - a.start.x) * dz - (b.start.z - a.start.z) * dx) / length;
}

function buildProximityHatchArea(
  source: GroundSegment,
  target: GroundSegment,
  id: string,
): ProximityHatchArea | null {
  const dx = source.end.x - source.start.x;
  const dz = source.end.z - source.start.z;
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length < 1e-6) return null;

  const ux = dx / length;
  const uz = dz / length;
  const normalX = -uz;
  const normalZ = ux;
  const project = (point: GroundPoint) =>
    (point.x - source.start.x) * ux + (point.z - source.start.z) * uz;

  const sourceStart = project(source.start);
  const sourceEnd = project(source.end);
  const targetStart = project(target.start);
  const targetEnd = project(target.end);
  const overlapStart = Math.max(
    Math.min(sourceStart, sourceEnd),
    Math.min(targetStart, targetEnd),
  );
  const overlapEnd = Math.min(
    Math.max(sourceStart, sourceEnd),
    Math.max(targetStart, targetEnd),
  );
  if (overlapEnd - overlapStart < 0.2) return null;

  const signedOffset =
    (target.start.x - source.start.x) * normalX +
    (target.start.z - source.start.z) * normalZ;
  const gapDistance = Math.abs(signedOffset);
  if (gapDistance < 0.01 || gapDistance > PROXIMITY_HATCH_DISTANCE) return null;

  const pointOnSource = (value: number): GroundPoint => ({
    x: source.start.x + ux * value,
    z: source.start.z + uz * value,
  });
  const pointOnTarget = (value: number): GroundPoint => ({
    x: source.start.x + ux * value + normalX * signedOffset,
    z: source.start.z + uz * value + normalZ * signedOffset,
  });

  const a = pointOnSource(overlapStart);
  const b = pointOnSource(overlapEnd);
  const c = pointOnTarget(overlapEnd);
  const d = pointOnTarget(overlapStart);

  const hatchSegments: Array<[GroundPoint, GroundPoint]> = [];
  const segmentLength = overlapEnd - overlapStart;
  const signedStep = Math.sign(signedOffset || 1) * PROXIMITY_HATCH_STEP;
  const count = Math.ceil((segmentLength + gapDistance) / PROXIMITY_HATCH_STEP);

  for (let index = -count; index <= count; index += 1) {
    const startValue = overlapStart + index * PROXIMITY_HATCH_STEP;
    const endValue = startValue + Math.abs(signedOffset);
    const clippedStart = THREE.MathUtils.clamp(startValue, overlapStart, overlapEnd);
    const clippedEnd = THREE.MathUtils.clamp(endValue, overlapStart, overlapEnd);
    if (clippedEnd - clippedStart < 0.05) continue;

    const sourcePoint = pointOnSource(clippedStart);
    const targetPoint = {
      x: source.start.x + ux * clippedEnd + normalX * signedOffset,
      z: source.start.z + uz * clippedEnd + normalZ * signedOffset,
    };

    if (signedStep < 0) {
      hatchSegments.push([targetPoint, sourcePoint]);
    } else {
      hatchSegments.push([sourcePoint, targetPoint]);
    }
  }

  return { id, corners: [a, b, c, d], hatchSegments };
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

function geometryCacheKey(model: IfcModelItem): string {
  return `${model.name}:${model.size}:${model.file.lastModified}:${model.geometryRevision}`;
}

function RotateCornerHandle({
  xDir,
  zDir,
  active,
  showLabel,
}: {
  xDir: 1 | -1;
  zDir: 1 | -1;
  active: boolean;
  showLabel: boolean;
}) {
  const arcPositions = useMemo(() => {
    const radius = 0.58;
    const segments = 12;
    const values: number[] = [];
    for (let i = 0; i <= segments; i += 1) {
      const t = (i / segments) * (Math.PI / 2);
      const x = xDir * radius * Math.cos(t);
      const z = zDir * radius * Math.sin(t);
      values.push(x, 0, z);
    }
    return new Float32Array(values);
  }, [xDir, zDir]);

  const edgePositions = useMemo(() => {
    const edge = 0.74;
    return new Float32Array([
      0,
      0,
      0,
      xDir * edge,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      zDir * edge,
    ]);
  }, [xDir, zDir]);

  return (
    <group>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[edgePositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={active ? "#ffffff" : "#94a3b8"} />
      </lineSegments>

      <line>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[arcPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={active ? "#ffffff" : "#94a3b8"} />
      </line>

      {showLabel && (
        <Html
          position={[0, 0.62, 0]}
          center
          transform={false}
          style={{ pointerEvents: "none", fontSize: "18px", lineHeight: "1.1" }}
        >
          <div className="rounded-full border-2 border-slate-100/70 bg-slate-950/95 px-3 py-1.5 text-sm font-bold tracking-[0.01em] text-white shadow-[0_8px_22px_rgba(0,0,0,0.65)]">
            Повернуть
          </div>
        </Html>
      )}
    </group>
  );
}

function AlignmentPlaneHighlight({
  source,
  target,
  minY,
  maxY,
}: {
  source: GroundSegment;
  target: GroundSegment;
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
    const values = [
      project(source.start),
      project(source.end),
      project(target.start),
      project(target.end),
    ];
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
  }, [maxY, minY, source, target]);

  if (positions.length === 0) return null;

  return (
    <mesh renderOrder={30}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshBasicMaterial
        color={ALIGNMENT_PLANE_COLOR}
        opacity={0.2}
        side={THREE.DoubleSide}
        transparent
      />
    </mesh>
  );
}

function ProximityHatchOverlay({ area }: { area: ProximityHatchArea }) {
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
    </group>
  );
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

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const perspective = camera as THREE.PerspectiveCamera;
    const target = new THREE.Vector3(0, 0, 0);
    const currentActiveObject = activeObjectRef.current;
    const bounds = currentActiveObject ? new THREE.Box3().setFromObject(currentActiveObject) : null;
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

    controls.update();
    invalidate();
  }, [camera, controlsRef, invalidate, viewMode]);

  return null;
}

export default function IfcViewport({
  models,
  activeModelId,
  viewMode,
  transformMode,
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
  const [cache, setCache] = useState<Map<string, CacheEntry>>(() => new Map());
  const [isSelected, setIsSelected] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [hoveredRotateHandleKey, setHoveredRotateHandleKey] = useState<string | null>(null);
  const loadingKeysRef = useRef<Set<string>>(new Set());
  const loadingControllersRef = useRef<Map<string, AbortController>>(new Map());

  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const placementGroupRef = useRef<THREE.Group | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const alignmentSnapRef = useRef<AlignmentSnapData | null>(null);
  const instanceObjectsRef = useRef<Map<string, { geometryKey: string; object: THREE.Group }>>(
    new Map(),
  );

  const activeModel = useMemo(
    () => models.find((item) => item.id === activeModelId) ?? null,
    [activeModelId, models],
  );
  const activePlacement = activeModel?.placement ?? ZERO_PLACEMENT;
  const activeModelStatus = activeModel?.analysisStatus ?? "queued";

  const [draftPlacement, setDraftPlacement] = useState<IfcModelItem["placement"]>(activePlacement);
  const draftPlacementRef = useRef(draftPlacement);
  useEffect(() => {
    draftPlacementRef.current = draftPlacement;
  }, [draftPlacement]);
  useEffect(() => {
    setDraftPlacement(activePlacement);
    dragStateRef.current = null;
    setIsTransforming(false);
    setIsSelected(Boolean(activeModelId && activeModel?.isPlaced));
  }, [activeModel?.isPlaced, activePlacement, activeModelId]);

  const activeObject = useMemo(() => {
    if (!activeModelId || !activeModel?.isPlaced || activeModelStatus !== "ready") return null;
    const cached = cache.get(geometryCacheKey(activeModel));
    if (!cached) return null;
    return cached.object;
  }, [activeModel, activeModelId, activeModelStatus, cache]);


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
    }

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
    },
    [],
  );

  const commitPlacement = useCallback(() => {
    if (!activeModelId) return;
    const nextPlacement = {
      x: draftPlacementRef.current.x,
      y: 0,
      z: draftPlacementRef.current.z,
      rotationY: normalizeAngle(draftPlacementRef.current.rotationY),
    };
    setDraftPlacement(nextPlacement);
    onPlacementCommit(activeModelId, nextPlacement);
  }, [activeModelId, onPlacementCommit]);

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
        return applyAlignmentSnap({
          ...previous,
          x: previous.x + nextDx,
          y: 0,
          z: previous.z + nextDz,
        });
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
        return {
          ...previous,
          rotationY: desiredRotation,
        };
      });
    }
  }, [applyAlignmentSnap, rotationSnapEnabled, rotationSnapStepDegrees]);

  const endDrag = useCallback((event: ThreeEvent<PointerEvent>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    const currentTarget = event.currentTarget as EventTarget & {
      releasePointerCapture?: (pointerId: number) => void;
    };
    currentTarget.releasePointerCapture?.(event.pointerId);

    dragStateRef.current = null;
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
      if (!camera || !canvasElement) {
        const placedModelId = onDropModel(droppedModelId, {
          x: model.placement.x,
          y: 0,
          z: model.placement.z,
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

      const placedModelId = onDropModel(droppedModelId, {
        x: hit ? point.x : model.placement.x,
        y: 0,
        z: hit ? point.z : model.placement.z,
        rotationY: model.placement.rotationY,
      });
      if (placedModelId) onSelectModel(placedModelId);
      setIsSelected(Boolean(placedModelId));
    },
    [models, onDropModel, onSelectModel],
  );

  const selectionBounds = useMemo(() => {
    if (!activeObject) return null;
    return updateSelectionBounds(activeObject);
  }, [activeObject]);

  const cornerHandles = useMemo(() => {
    if (!selectionBounds) return [] as Array<[number, number, number]>;
    const { minX, maxX, minZ, maxZ } = selectionBounds;
    return [
      [minX, 0, minZ],
      [maxX, 0, minZ],
      [maxX, 0, maxZ],
      [minX, 0, maxZ],
    ];
  }, [selectionBounds]);

  const rotateHandleOffset = useMemo(() => {
    if (!selectionBounds) return 0.34;
    const width = Math.max(selectionBounds.maxX - selectionBounds.minX, 1);
    const depth = Math.max(selectionBounds.maxZ - selectionBounds.minZ, 1);
    const span = Math.max(width, depth);
    return THREE.MathUtils.clamp(span * 0.03, 0.3, 0.9);
  }, [selectionBounds]);

  const moveHandles = useMemo(() => {
    if (!selectionBounds) return [] as Array<[number, number, number]>;
    const { minX, maxX, minZ, maxZ } = selectionBounds;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    return [
      [cx, 0, cz],
      [minX, 0, cz],
      [maxX, 0, cz],
      [cx, 0, minZ],
      [cx, 0, maxZ],
    ];
  }, [selectionBounds]);

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
            return { model: item, object: existing.object };
          }

          const instanceObject = entry.object.clone(true);
          instanceObjectsRef.current.set(item.id, {
            geometryKey,
            object: instanceObject,
          });
          return { model: item, object: instanceObject };
        })
        .filter((value): value is { model: IfcModelItem; object: THREE.Group } => Boolean(value));

      for (const [instanceId] of instanceObjectsRef.current) {
        if (validInstanceIds.has(instanceId)) continue;
        instanceObjectsRef.current.delete(instanceId);
      }

      return list;
    },
    [cache, models],
  );

  const sceneGroundFootprints = useMemo(() => {
    return sceneModels
      .map(({ model: sceneModel, object }) => {
        const placement = activeModelId === sceneModel.id ? draftPlacement : sceneModel.placement;
        const bounds = updateSelectionBounds(object);

        const localCorners: [GroundPoint, GroundPoint, GroundPoint, GroundPoint] = [
          { x: bounds.minX, z: bounds.minZ },
          { x: bounds.maxX, z: bounds.minZ },
          { x: bounds.maxX, z: bounds.maxZ },
          { x: bounds.minX, z: bounds.maxZ },
        ];
        const corners = localCorners.map((point) =>
          transformLocalGroundPoint(point, placement),
        ) as [GroundPoint, GroundPoint, GroundPoint, GroundPoint];

        return {
          id: sceneModel.id,
          center: { x: placement.x, z: placement.z },
          corners,
          minY: bounds.minY + placement.y,
          maxY: bounds.maxY + placement.y,
        } satisfies ModelGroundFootprint;
      })
      .filter((value): value is ModelGroundFootprint => Boolean(value));
  }, [activeModelId, draftPlacement, sceneModels]);

  const activeGroundFootprint = useMemo(
    () => sceneGroundFootprints.find((item) => item.id === activeModelId) ?? null,
    [activeModelId, sceneGroundFootprints],
  );

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
    if (!activeModelId || !activeGroundFootprint || !isTransforming) {
      return [] as ProximityHatchArea[];
    }

    const activeEdges = getFootprintEdgeSegments(activeGroundFootprint.corners);

    return sceneGroundFootprints
      .filter((footprint) => footprint.id !== activeModelId)
      .map((footprint) => {
        let bestArea: ProximityHatchArea | null = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const source of activeEdges) {
          for (const target of getFootprintEdgeSegments(footprint.corners)) {
            if (getParallelDelta(source, target) > PROXIMITY_HATCH_EDGE_TOLERANCE) continue;
            const area = buildProximityHatchArea(
              source,
              target,
              `${activeModelId}:${footprint.id}:${source.edge}:${target.edge}:hatch`,
            );
            if (!area) continue;

            const score = getParallelLineDistance(source, target);
            if (score >= bestScore) continue;
            bestScore = score;
            bestArea = area;
          }
        }

        return bestArea;
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
            minY: Math.min(activeGroundFootprint.minY, footprint.minY),
            maxY: Math.max(activeGroundFootprint.maxY, footprint.maxY),
          };
        }
      }
    }

    return bestHint;
  }, [activeGroundFootprint, activeModelId, isTransforming, sceneGroundFootprints]);

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

  const rotateHandleColor = transformMode === "rotate" ? "#3b82f6" : "#60a5fa";
  const moveHandleColor = transformMode === "translate" ? "#22c55e" : "#4ade80";

  return (
    <div
      className="relative h-full w-full bg-slate-950"
      onDragOver={handleDragOver}
      onDrop={handleDropModel}
    >
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [15, 12, 15], fov: 45, near: 0.1, far: 20000 }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ camera, gl }) => {
          cameraRef.current = camera;
          canvasElementRef.current = gl.domElement;
        }}
        onPointerMissed={() => {
          if (!dragStateRef.current) setIsSelected(false);
        }}
      >
        <color attach="background" args={["#020617"]} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[20, 30, 20]} intensity={1.1} />
        <directionalLight position={[-18, 8, -12]} intensity={0.4} />
        <gridHelper args={[200, 60, "#475569", "#1e293b"]} />

        {sceneModels.map(({ model: sceneModel, object }) => {
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
                  if (transformMode === "translate") beginMoveDrag(event);
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />

              {isActive && isSelected && selectionBounds && (
                <>
                  <line>
                    <bufferGeometry>
                      <bufferAttribute
                        attach="attributes-position"
                        args={[
                          new Float32Array([
                            selectionBounds.minX,
                            0,
                            selectionBounds.minZ,
                            selectionBounds.maxX,
                            0,
                            selectionBounds.minZ,

                            selectionBounds.maxX,
                            0,
                            selectionBounds.minZ,
                            selectionBounds.maxX,
                            0,
                            selectionBounds.maxZ,

                            selectionBounds.maxX,
                            0,
                            selectionBounds.maxZ,
                            selectionBounds.minX,
                            0,
                            selectionBounds.maxZ,

                            selectionBounds.minX,
                            0,
                            selectionBounds.maxZ,
                            selectionBounds.minX,
                            0,
                            selectionBounds.minZ,
                          ]),
                          3,
                        ]}
                      />
                    </bufferGeometry>
                    <lineBasicMaterial color="#60a5fa" linewidth={1} />
                  </line>

                  {moveHandles.map((pos, index) => (
                    <mesh
                      key={`move-${index}`}
                      position={[pos[0], 0.05, pos[2]]}
                      onPointerDown={beginMoveDrag}
                      onPointerMove={handlePointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                    >
                      <sphereGeometry args={[0.18, 16, 16]} />
                      <meshBasicMaterial color={moveHandleColor} />
                    </mesh>
                  ))}

                  {cornerHandles.map((pos, index) => {
                    const handleKey = `${activeModelId ?? "no-model"}:${index}`;
                    const isMinX = pos[0] <= selectionBounds.minX + 0.0001;
                    const isMinZ = pos[2] <= selectionBounds.minZ + 0.0001;
                    const xDir: 1 | -1 = isMinX ? -1 : 1;
                    const zDir: 1 | -1 = isMinZ ? -1 : 1;
                    const handleX = pos[0] + xDir * rotateHandleOffset;
                    const handleZ = pos[2] + zDir * rotateHandleOffset;
                    return (
                      <mesh
                        key={`rotate-${index}`}
                        position={[handleX, 0.06, handleZ]}
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
                      >
                      <sphereGeometry args={[0.18, 22, 22]} />
                      <meshBasicMaterial color={rotateHandleColor} />
                        <RotateCornerHandle
                          xDir={xDir}
                          zDir={zDir}
                          active={hoveredRotateHandleKey === handleKey}
                          showLabel={hoveredRotateHandleKey === handleKey}
                        />
                      </mesh>
                    );
                  })}
                </>
              )}
            </group>
          );
        })}

        {proximityHatchAreas.map((area) => (
          <ProximityHatchOverlay key={area.id} area={area} />
        ))}

        {measurementLines.map((line) => (
          <group key={line.id}>
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[new Float32Array([...line.sourceCenter, ...line.start]), 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#334155" />
            </line>
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[new Float32Array([...line.targetCenter, ...line.end]), 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#334155" />
            </line>
            <line>
              <bufferGeometry>
                <bufferAttribute
                  attach="attributes-position"
                  args={[new Float32Array([...line.start, ...line.end]), 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial color="#3b82f6" />
            </line>
            <mesh position={line.start}>
              <sphereGeometry args={[0.18, 18, 18]} />
              <meshBasicMaterial color="#60a5fa" />
            </mesh>
            <mesh position={line.end}>
              <sphereGeometry args={[0.18, 18, 18]} />
              <meshBasicMaterial color="#22d3ee" />
            </mesh>
            <Html
              position={line.label}
              center
              transform={false}
              style={{ pointerEvents: "none", fontSize: "20px", lineHeight: "1.1" }}
            >
              <div className="whitespace-nowrap rounded-md border-2 border-cyan-200/90 bg-slate-950/95 px-3 py-1.5 text-sm font-bold tracking-[0.01em] text-cyan-100 shadow-[0_8px_24px_rgba(0,0,0,0.65)]">
                {formatMeters(line.distance)}
              </div>
            </Html>
          </group>
        ))}

        {alignmentPlaneHint && (
          <group key={alignmentPlaneHint.id}>
            <AlignmentPlaneHighlight
              maxY={alignmentPlaneHint.maxY}
              minY={alignmentPlaneHint.minY}
              source={alignmentPlaneHint.source}
              target={alignmentPlaneHint.target}
            />
          </group>
        )}

        <CameraController
          activeObject={activeObject}
          viewMode={viewMode}
          controlsRef={controlsRef}
        />

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
      </Canvas>

      {overlayText && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-slate-300">
          {overlayText}
        </div>
      )}
    </div>
  );
}
