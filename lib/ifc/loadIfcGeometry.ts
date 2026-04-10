import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { IfcGeometryStats } from "@/types/ifc";
import { getIfcApi } from "@/lib/ifc/getIfcApi";

interface LoadIfcGeometryOptions {
  onProgress?: (value: number) => void;
  signal?: AbortSignal;
}

interface LoadIfcGeometryResult {
  group: THREE.Group;
  stats: IfcGeometryStats;
}

function colorKey(r: number, g: number, b: number, a: number): string {
  return `${r.toFixed(3)}-${g.toFixed(3)}-${b.toFixed(3)}-${a.toFixed(3)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Cancelled");
}

function safeDelete(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as { delete?: unknown };
  if (typeof candidate.delete === "function") {
    candidate.delete();
  }
}

function alignGroupToCenterGround(group: THREE.Group): IfcGeometryStats["placement"] {
  const bounds = new THREE.Box3().setFromObject(group);
  if (bounds.isEmpty()) {
    return {
      mode: "center-ground",
      offset: { x: 0, y: 0, z: 0 },
      sourceBounds: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 },
      },
    };
  }

  const center = bounds.getCenter(new THREE.Vector3());

  // Insert mode:
  // 1) Center of model projection on X/Z axis goes to world origin X/Z.
  // 2) Lowest Y point goes to ground level (Y=0).
  const offsetX = -center.x;
  const offsetY = -bounds.min.y;
  const offsetZ = -center.z;
  group.position.set(offsetX, offsetY, offsetZ);

  return {
    mode: "center-ground",
    offset: { x: offsetX, y: offsetY, z: offsetZ },
    sourceBounds: {
      min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
      max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
    },
  };
}

export async function loadIfcGeometry(
  file: File,
  options: LoadIfcGeometryOptions = {},
): Promise<LoadIfcGeometryResult> {
  const startedAt = performance.now();
  const api = await getIfcApi();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const group = new THREE.Group();
  group.name = file.name;

  let modelId = -1;
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;

  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const geometryBuckets = new Map<
    string,
    { material: THREE.MeshStandardMaterial; geometries: THREE.BufferGeometry[] }
  >();

  try {
    throwIfAborted(options.signal);
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
    if (modelId < 0) throw new Error("web-ifc could not open this file.");

    api.StreamAllMeshes(modelId, (flatMesh, index, total) => {
      throwIfAborted(options.signal);

      for (let i = 0; i < flatMesh.geometries.size(); i += 1) {
        const placed = flatMesh.geometries.get(i);
        const ifcGeometry = api.GetGeometry(modelId, placed.geometryExpressID);

        const srcVertices = api.GetVertexArray(
          ifcGeometry.GetVertexData(),
          ifcGeometry.GetVertexDataSize(),
        );
        const srcIndices = api.GetIndexArray(
          ifcGeometry.GetIndexData(),
          ifcGeometry.GetIndexDataSize(),
        );

        const vertexCount = Math.floor(srcVertices.length / 6);
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);

        for (let source = 0, target = 0; source < srcVertices.length; source += 6, target += 3) {
          positions[target] = srcVertices[source];
          positions[target + 1] = srcVertices[source + 1];
          positions[target + 2] = srcVertices[source + 2];

          normals[target] = srcVertices[source + 3];
          normals[target + 1] = srcVertices[source + 4];
          normals[target + 2] = srcVertices[source + 5];
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(srcIndices), 1));

        const transform = new THREE.Matrix4().fromArray(placed.flatTransformation);
        geometry.applyMatrix4(transform);

        const r = Math.min(Math.max(placed.color.x, 0), 1);
        const g = Math.min(Math.max(placed.color.y, 0), 1);
        const b = Math.min(Math.max(placed.color.z, 0), 1);
        const a = Math.min(Math.max(placed.color.w, 0), 1);
        const key = colorKey(r, g, b, a);

        let material = materialCache.get(key);
        if (!material) {
          material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(r, g, b),
            transparent: a < 0.999,
            opacity: Math.max(a, 0.15),
            roughness: 0.85,
            metalness: 0.05,
          });
          materialCache.set(key, material);
        }

        const bucket = geometryBuckets.get(key);
        if (bucket) {
          bucket.geometries.push(geometry);
        } else {
          geometryBuckets.set(key, { material, geometries: [geometry] });
        }

        meshes += 1;
        vertices += vertexCount;
        triangles += Math.floor(srcIndices.length / 3);

        safeDelete(ifcGeometry);
      }

      safeDelete(flatMesh);
      if (total > 0) options.onProgress?.((index + 1) / total);
    });

    for (const bucket of geometryBuckets.values()) {
      const mergedGeometry =
        bucket.geometries.length === 1
          ? bucket.geometries[0]
          : mergeGeometries(bucket.geometries, false);

      if (mergedGeometry) {
        if (bucket.geometries.length > 1) {
          for (const geometry of bucket.geometries) {
            geometry.dispose();
          }
        }
        const mesh = new THREE.Mesh(mergedGeometry, bucket.material);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        continue;
      }

      for (const geometry of bucket.geometries) {
        const mesh = new THREE.Mesh(geometry, bucket.material);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
      }
    }

    const placement = alignGroupToCenterGround(group);

    options.onProgress?.(1);

    return {
      group,
      stats: {
        meshes,
        triangles,
        vertices,
        buildMs: performance.now() - startedAt,
        placement,
      },
    };
  } finally {
    if (modelId >= 0) api.CloseModel(modelId);
  }
}
