import type { IfcModelItem } from "@/types/ifc";

export type GroundCorner = { x: number; z: number };

/** Угол следа на земле: порядок как в computeWorldFootprintFromObject (локальный обход прямоугольника). */
export type ArchitecturalModelDetail = {
  id: string;
  name: string;
  sourceFile: {
    name: string;
    sizeBytes: number;
    sizeHuman: string;
  };
  placement: {
    x: number;
    y: number;
    z: number;
    rotationYDeg: number;
    rotationYRad: number;
  };
  ifcAnalysis?: {
    schema: string;
    entityTotal: number;
    elementMetrics: {
      walls: number;
      slabs: number;
      doors: number;
      windows: number;
      spaces: number;
    };
  };
  geometryMesh?: {
    meshCount: number;
    triangleCount: number;
    vertexCount: number;
    buildMs: number;
  };
  /** Локальный AABB корня IFC до размещения на сайте (м). */
  localRootBounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    size: { width: number; height: number; depth: number };
  };
  /** Смещение «центр–земля» из пайплайна геометрии (м). */
  centerGroundOffset: { x: number; y: number; z: number };
  /** След на участке: четыре угла в мировых XZ, высота здания в мире. */
  world: {
    footprintPolygonMeters: Array<{ index: number; x: number; z: number }>;
    edgeLengthsMeters: [number, number, number, number];
    footprintAreaApproxSqM: number;
    heightSpanMeters: number;
    verticalMinY: number;
    verticalMaxY: number;
    axisAlignedFootprint: {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      extentX: number;
      extentZ: number;
    };
  };
  /** Текст для генератора: воспроизвести объём и архитектурный характер. */
  reconstructionPromptRu: string;
  reconstructionPromptEn: string;
};

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function polygonAreaXZ(corners: GroundCorner[]): number {
  if (corners.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const j = (i + 1) % corners.length;
    sum += corners[i].x * corners[j].z - corners[j].x * corners[i].z;
  }
  return Math.abs(sum) * 0.5;
}

function edgeLength(a: GroundCorner, b: GroundCorner): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/**
 * Собирает детальное описание одной размещённой модели для промпта (NanoBanana и др.).
 */
export function buildArchitecturalModelDetail(
  model: IfcModelItem,
  placement: IfcModelItem["placement"],
  footprint: {
    corners: [GroundCorner, GroundCorner, GroundCorner, GroundCorner];
    minY: number;
    maxY: number;
  },
  localBounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  },
): ArchitecturalModelDetail {
  const lw = localBounds.maxX - localBounds.minX;
  const lh = localBounds.maxY - localBounds.minY;
  const ld = localBounds.maxZ - localBounds.minZ;

  const gs = model.geometryStats;
  const centerGroundOffset = gs
    ? { x: gs.placement.offset.x, y: gs.placement.offset.y, z: gs.placement.offset.z }
    : { x: 0, y: 0, z: 0 };

  const [c0, c1, c2, c3] = footprint.corners;
  const edgeLengths: [number, number, number, number] = [
    round4(edgeLength(c0, c1)),
    round4(edgeLength(c1, c2)),
    round4(edgeLength(c2, c3)),
    round4(edgeLength(c3, c0)),
  ];
  const area = round4(polygonAreaXZ(footprint.corners));

  const xs = footprint.corners.map((c) => c.x);
  const zs = footprint.corners.map((c) => c.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  const rotDeg = round4((placement.rotationY * 180) / Math.PI);

  const analysis = model.analysis;
  const ifcAnalysis = analysis
    ? {
        schema: analysis.schema,
        entityTotal: analysis.entityTotal,
        elementMetrics: { ...analysis.elementMetrics },
      }
    : undefined;

  const geometryMesh = model.geometryStats
    ? {
        meshCount: model.geometryStats.meshes,
        triangleCount: model.geometryStats.triangles,
        vertexCount: model.geometryStats.vertices,
        buildMs: model.geometryStats.buildMs,
      }
    : undefined;

  const nameShort = model.name.length > 80 ? `${model.name.slice(0, 77)}…` : model.name;

  const reconstructionPromptRu = [
    `Модель «${nameShort}» (IFC): воспроизведи здание с теми же масштабом и силуэтом.`,
    analysis
      ? `По данным IFC: схема ${analysis.schema}, сущностей ${analysis.entityTotal}; стен ${analysis.elementMetrics.walls}, плит/перекрытий ${analysis.elementMetrics.slabs}, дверей ${analysis.elementMetrics.doors}, окон ${analysis.elementMetrics.windows}, пространств ${analysis.elementMetrics.spaces}. Соблюдай пропорции фасада и ритм проёмов.`
      : `Точные IFC-метрики недоступны; опирайся на габариты и след ниже.`,
    `Локальный габарит корня (м): ширина ${round4(lw)}, высота ${round4(lh)}, глубина ${round4(ld)}.`,
    `На участке: поворот вокруг Y ≈ ${rotDeg}°, центр группы в (${round4(placement.x)}, ${round4(placement.y)}, ${round4(placement.z)}).`,
    `След на земле (м, XZ): площадь ≈ ${area} м²; стороны контура по рёбрам ≈ ${edgeLengths.join(", ")} м; ось-выровненный прямоугольник следа: по X ≈ ${round4(maxX - minX)} м, по Z ≈ ${round4(maxZ - minZ)} м.`,
    `Высота здания в сцене (мировая Y): от ${round4(footprint.minY)} до ${round4(footprint.maxY)} (размах ${round4(footprint.maxY - footprint.minY)} м).`,
    geometryMesh
      ? `Мешей ${geometryMesh.meshCount}, треугольников ${geometryMesh.triangleCount} — визуал должен быть детализированным, без упрощения до примитива.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const reconstructionPromptEn = [
    `Building «${nameShort}» (IFC source): match the same scale and silhouette.`,
    analysis
      ? `IFC metrics: schema ${analysis.schema}, ${analysis.entityTotal} entities; walls ${analysis.elementMetrics.walls}, slabs ${analysis.elementMetrics.slabs}, doors ${analysis.elementMetrics.doors}, windows ${analysis.elementMetrics.windows}, spaces ${analysis.elementMetrics.spaces}. Respect façade proportions and opening rhythm.`
      : `IFC metrics unavailable; rely on dimensions and footprint below.`,
    `Local root size (m): width ${round4(lw)}, height ${round4(lh)}, depth ${round4(ld)}.`,
    `On site: rotation about Y ≈ ${rotDeg}°, group origin at (${round4(placement.x)}, ${round4(placement.y)}, ${round4(placement.z)}).`,
    `Ground footprint (m, XZ): area ≈ ${area} m²; edge lengths ≈ ${edgeLengths.join(", ")} m; axis-aligned span ≈ ${round4(maxX - minX)} m (X) by ${round4(maxZ - minZ)} m (Z).`,
    `World vertical extent (Y): ${round4(footprint.minY)} … ${round4(footprint.maxY)} m (span ${round4(footprint.maxY - footprint.minY)} m).`,
    geometryMesh
      ? `Meshes ${geometryMesh.meshCount}, triangles ${geometryMesh.triangleCount} — keep rich geometric detail, not a primitive block.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: model.id,
    name: model.name,
    sourceFile: {
      name: model.name,
      sizeBytes: model.size,
      sizeHuman: formatBytes(model.size),
    },
    placement: {
      x: round4(placement.x),
      y: round4(placement.y),
      z: round4(placement.z),
      rotationYDeg: rotDeg,
      rotationYRad: round4(placement.rotationY),
    },
    ifcAnalysis,
    geometryMesh,
    localRootBounds: {
      min: { x: localBounds.minX, y: localBounds.minY, z: localBounds.minZ },
      max: { x: localBounds.maxX, y: localBounds.maxY, z: localBounds.maxZ },
      size: { width: round4(lw), height: round4(lh), depth: round4(ld) },
    },
    centerGroundOffset: {
      x: round4(centerGroundOffset.x),
      y: round4(centerGroundOffset.y),
      z: round4(centerGroundOffset.z),
    },
    world: {
      footprintPolygonMeters: footprint.corners.map((c, index) => ({
        index,
        x: round4(c.x),
        z: round4(c.z),
      })),
      edgeLengthsMeters: edgeLengths,
      footprintAreaApproxSqM: area,
      heightSpanMeters: round4(footprint.maxY - footprint.minY),
      verticalMinY: round4(footprint.minY),
      verticalMaxY: round4(footprint.maxY),
      axisAlignedFootprint: {
        minX: round4(minX),
        maxX: round4(maxX),
        minZ: round4(minZ),
        maxZ: round4(maxZ),
        extentX: round4(maxX - minX),
        extentZ: round4(maxZ - minZ),
      },
    },
    reconstructionPromptRu,
    reconstructionPromptEn,
  };
}
