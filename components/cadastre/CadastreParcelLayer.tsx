"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { useParcelBaseStore } from "@/store/parcelBaseStore";
import { VIEWPORT_OUTDOOR_SPEC } from "@/lib/viewportOutdoorSpec";

const TERRAIN_WORLD_Y_OFFSET = VIEWPORT_OUTDOOR_SPEC.ground.planeY + 0.012;
const BORDER_SURFACE_OFFSET = 0.12;
const ZONE_SURFACE_OFFSET = 0.03;
const ZONE_BORDER_OFFSET = 0.07;
const SETBACK_SIDE_M = 3;
const SETBACK_STREET_LINE_M = 5;
const VIOLATION_HATCH_OFFSET = 0.08;

function signedArea2(points: THREE.Vector2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

function intersectLines(
  p: THREE.Vector2,
  d: THREE.Vector2,
  q: THREE.Vector2,
  e: THREE.Vector2,
): THREE.Vector2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const qp = new THREE.Vector2(q.x - p.x, q.y - p.y);
  const t = (qp.x * e.y - qp.y * e.x) / den;
  return new THREE.Vector2(p.x + d.x * t, p.y + d.y * t);
}

function signedDistanceToLine(point: THREE.Vector2, linePoint: THREE.Vector2, lineDir: THREE.Vector2): number {
  // Positive means point is on the left side of lineDir.
  const relX = point.x - linePoint.x;
  const relY = point.y - linePoint.y;
  return lineDir.x * relY - lineDir.y * relX;
}

function intersectSegmentWithLine(
  a: THREE.Vector2,
  b: THREE.Vector2,
  linePoint: THREE.Vector2,
  lineDir: THREE.Vector2,
): THREE.Vector2 | null {
  const segDir = b.clone().sub(a);
  return intersectLines(a, segDir, linePoint, lineDir);
}

function clipPolygonByHalfPlane(
  poly: THREE.Vector2[],
  linePoint: THREE.Vector2,
  lineDir: THREE.Vector2,
): THREE.Vector2[] {
  if (poly.length < 3) return [];
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = signedDistanceToLine(a, linePoint, lineDir);
    const db = signedDistanceToLine(b, linePoint, lineDir);
    const inA = da >= -1e-7;
    const inB = db >= -1e-7;

    if (inA && inB) {
      out.push(b.clone());
      continue;
    }
    if (inA && !inB) {
      const hit = intersectSegmentWithLine(a, b, linePoint, lineDir);
      if (hit) out.push(hit);
      continue;
    }
    if (!inA && inB) {
      const hit = intersectSegmentWithLine(a, b, linePoint, lineDir);
      if (hit) out.push(hit);
      out.push(b.clone());
    }
  }
  return out;
}

function pointToSegmentDistance(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const ab = b.clone().sub(a);
  const ap = point.clone().sub(a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-9) return point.distanceTo(a);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / len2, 0, 1);
  const closest = a.clone().addScaledVector(ab, t);
  return point.distanceTo(closest);
}

function pointInPolygon2(point: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / Math.max(1e-12, pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function orient(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: THREE.Vector2, b: THREE.Vector2, p: THREE.Vector2): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

function segmentsIntersect2(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, d: THREE.Vector2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (Math.abs(o1) < 1e-9 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(c, d, b)) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function polygonsIntersect2(polyA: THREE.Vector2[], polyB: THREE.Vector2[]): boolean {
  if (!polyA.length || !polyB.length) return false;
  for (let i = 0; i < polyA.length; i += 1) {
    const a1 = polyA[i]!;
    const a2 = polyA[(i + 1) % polyA.length]!;
    for (let j = 0; j < polyB.length; j += 1) {
      const b1 = polyB[j]!;
      const b2 = polyB[(j + 1) % polyB.length]!;
      if (segmentsIntersect2(a1, a2, b1, b2)) return true;
    }
  }
  if (pointInPolygon2(polyA[0]!, polyB)) return true;
  if (pointInPolygon2(polyB[0]!, polyA)) return true;
  return false;
}

function closestPointsSegmentToSegment2(
  p1: THREE.Vector2,
  q1: THREE.Vector2,
  p2: THREE.Vector2,
  q2: THREE.Vector2,
): { a: THREE.Vector2; b: THREE.Vector2; dist: number } {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-12;

  let s = 0;
  let t = 0;

  if (a <= EPS && e <= EPS) {
    const cpA = p1.clone();
    const cpB = p2.clone();
    return { a: cpA, b: cpB, dist: cpA.distanceTo(cpB) };
  }

  if (a <= EPS) {
    s = 0;
    t = THREE.MathUtils.clamp(f / Math.max(e, EPS), 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / Math.max(a, EPS), 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      if (Math.abs(denom) > EPS) {
        s = THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1);
      } else {
        s = 0;
      }
      const tNom = b * s + f;
      if (tNom < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / Math.max(a, EPS), 0, 1);
      } else if (tNom > e) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / Math.max(a, EPS), 0, 1);
      } else {
        t = tNom / Math.max(e, EPS);
      }
    }
  }

  const cpA = p1.clone().addScaledVector(d1, s);
  const cpB = p2.clone().addScaledVector(d2, t);
  return { a: cpA, b: cpB, dist: cpA.distanceTo(cpB) };
}

function mathToWorld(p: THREE.Vector2): THREE.Vector2 {
  // Internal math space uses (x, -z). Render/world uses (x, z).
  return new THREE.Vector2(p.x, -p.y);
}

function angleDegAtVertex(prev: THREE.Vector2, curr: THREE.Vector2, next: THREE.Vector2): number {
  const v1 = prev.clone().sub(curr).normalize();
  const v2 = next.clone().sub(curr).normalize();
  const dot = THREE.MathUtils.clamp(v1.dot(v2), -1, 1);
  return THREE.MathUtils.radToDeg(Math.acos(dot));
}

function simplifyNearStraightEdges(
  ring: THREE.Vector2[],
  minAngleDeg: number,
  maxAngleDeg: number,
): THREE.Vector2[] {
  if (ring.length < 4) return ring.map((p) => p.clone());
  let out = ring.map((p) => p.clone());
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const nextOut: THREE.Vector2[] = [];
    for (let i = 0; i < out.length; i += 1) {
      const prev = out[(i - 1 + out.length) % out.length]!;
      const curr = out[i]!;
      const next = out[(i + 1) % out.length]!;
      const lenPrev = prev.distanceTo(curr);
      const lenNext = curr.distanceTo(next);
      // Keep tiny kinks to avoid deleting meaningful sharp corners caused by very short edges.
      if (lenPrev < 1e-3 || lenNext < 1e-3) {
        nextOut.push(curr);
        continue;
      }
      const angle = angleDegAtVertex(prev, curr, next);
      const isNearStraight = angle >= minAngleDeg && angle <= maxAngleDeg;
      if (isNearStraight && out.length > 3) {
        changed = true;
        continue;
      }
      nextOut.push(curr);
    }
    if (nextOut.length < 3) break;
    out = nextOut;
  }
  return out;
}

/** Подложка участка (полигон на «земле»), центр сцены = центроид участка. */
export function CadastreParcelLayer({
  activeFootprintCorners,
}: {
  activeFootprintCorners?: Array<{ x: number; z: number }> | null;
}) {
  const parcel = useParcelBaseStore((s) => s.parcel);
  const streetLineEdgeIndex = useParcelBaseStore((s) => s.streetLineEdgeIndex);
  const ring2 = useMemo(() => {
    if (!parcel?.ringClosedXZ?.length) return [] as THREE.Vector2[];
    const raw = parcel.ringClosedXZ.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, -z));
    return simplifyNearStraightEdges(raw, 178, 182);
  }, [parcel?.ringClosedXZ]);

  const streetLineIndex = streetLineEdgeIndex ?? -1;
  const ringArea = useMemo(() => (ring2.length >= 3 ? signedArea2(ring2) : 0), [ring2]);
  const ccw = ringArea >= 0;

  const activeModelFootprint2 = useMemo(() => {
    if (!activeFootprintCorners || activeFootprintCorners.length < 3) return [] as THREE.Vector2[];
    // Единый источник истины: footprint из IfcViewport (фактическая вертикальная проекция на плоскость).
    return activeFootprintCorners.map((p) => new THREE.Vector2(p.x, -p.z));
  }, [activeFootprintCorners]);

  const activeModelFootprintRender = useMemo(() => {
    if (activeFootprintCorners && activeFootprintCorners.length >= 3) {
      // Render in scene world coordinates directly.
      return activeFootprintCorners.map((p) => new THREE.Vector2(p.x, p.z));
    }
    // Fallback: convert from math space (x, -z) back to world (x, z).
    return activeModelFootprint2.map((p) => new THREE.Vector2(p.x, -p.y));
  }, [activeFootprintCorners, activeModelFootprint2]);

  const edgeMeasurements = useMemo(() => {
    if (activeModelFootprint2.length < 3 || ring2.length < 2) {
      return [] as Array<{
        edgeIndex: number;
        a: THREE.Vector2;
        b: THREE.Vector2;
        limit: number;
        minDist: number;
        violation: boolean;
        corner: THREE.Vector2;
        foot: THREE.Vector2;
      }>;
    }
    const rows: Array<{
      edgeIndex: number;
      a: THREE.Vector2;
      b: THREE.Vector2;
      limit: number;
      minDist: number;
      violation: boolean;
      corner: THREE.Vector2;
      foot: THREE.Vector2;
    }> = [];
    for (let i = 0; i < ring2.length; i += 1) {
      const a = ring2[i]!;
      const b = ring2[(i + 1) % ring2.length]!;
      const ab = b.clone().sub(a);
      const edgeLen = Math.max(1e-9, ab.length());
      const dir = ab.clone().multiplyScalar(1 / edgeLen);
      const inward = ccw ? new THREE.Vector2(-dir.y, dir.x) : new THREE.Vector2(dir.y, -dir.x);
      const limit = i === streetLineIndex ? SETBACK_STREET_LINE_M : SETBACK_SIDE_M;
      let bestCorner = activeModelFootprint2[0]!;
      let bestDist = Number.POSITIVE_INFINITY;
      let minSignedInward = Number.POSITIVE_INFINITY;
      for (const corner of activeModelFootprint2) {
        const rel = corner.clone().sub(a);
        minSignedInward = Math.min(minSignedInward, rel.dot(inward));
        const t = THREE.MathUtils.clamp(rel.dot(dir), 0, edgeLen);
        const footOnSegment = a.clone().addScaledVector(dir, t);
        const segDist = corner.distanceTo(footOnSegment);
        if (segDist < bestDist) {
          bestDist = segDist;
          bestCorner = corner;
        }
      }
      const rel = bestCorner.clone().sub(a);
      const t = THREE.MathUtils.clamp(rel.dot(dir), 0, edgeLen);
      const foot = a.clone().addScaledVector(dir, t);
      const minDist = bestCorner.distanceTo(foot);
      rows.push({
        edgeIndex: i,
        a,
        b,
        limit,
        minDist: Math.max(0, minSignedInward),
        // Нарушение считаем тем же критерием, что и зону отступа: относительно внутренней полуплоскости.
        violation: minSignedInward + 1e-4 < limit,
        corner: bestCorner.clone(),
        foot,
      });
    }
    return rows;
  }, [activeModelFootprint2, ccw, ring2, streetLineIndex]);

  const violationEdgeIndexes = useMemo(() => {
    return edgeMeasurements
      .filter((m) => m.violation)
      .map((m) => m.edgeIndex);
  }, [edgeMeasurements]);
  const hasViolation = violationEdgeIndexes.length > 0;

  const edgeDistanceLabels = useMemo(() => {
    if (!edgeMeasurements.length) return [] as Array<{
      key: string;
      position: THREE.Vector3;
      text: string;
      violation: boolean;
    }>;
    const labels: Array<{ key: string; position: THREE.Vector3; text: string; violation: boolean }> = [];
    for (const m of edgeMeasurements) {
      const a = m.a;
      const b = m.b;
      const dir = b.clone().sub(a).normalize();
      const inward = ccw ? new THREE.Vector2(-dir.y, dir.x) : new THREE.Vector2(dir.y, -dir.x);
      const midMath = a.clone().add(b).multiplyScalar(0.5).addScaledVector(inward, 0.9);
      const mid = mathToWorld(midMath);
      const y = TERRAIN_WORLD_Y_OFFSET + 0.2;
      labels.push({
        key: `edge-dist-label-${m.edgeIndex}`,
        position: new THREE.Vector3(mid.x, y, mid.y),
        text: `${m.minDist.toFixed(1)}м / ${m.limit.toFixed(1)}м`,
        violation: m.violation,
      });
    }
    return labels;
  }, [ccw, edgeMeasurements]);

  const edgePerpendicularLines = useMemo(() => {
    if (!edgeMeasurements.length) return [] as Array<{ key: string; points: THREE.Vector3[]; violation: boolean }>;
    return edgeMeasurements.map((m) => {
      const foot = mathToWorld(m.foot);
      const corner = mathToWorld(m.corner);
      const y0 = TERRAIN_WORLD_Y_OFFSET + 0.1;
      const y1 = TERRAIN_WORLD_Y_OFFSET + 0.1;
      return {
        key: `edge-perp-${m.edgeIndex}`,
        points: [new THREE.Vector3(foot.x, y0, foot.y), new THREE.Vector3(corner.x, y1, corner.y)],
        violation: m.violation,
      };
    });
  }, [edgeMeasurements]);

  const measurementContourGeometry = useMemo(() => {
    if (edgeMeasurements.length < 3) return null;
    const n = edgeMeasurements.length;
    const fallbackHalfLen = 0.8;
    const outer: THREE.Vector2[] = new Array(n);
    const inner: THREE.Vector2[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const m = edgeMeasurements[i]!;
      const prev = edgeMeasurements[(i - 1 + n) % n]!;
      const next = edgeMeasurements[(i + 1) % n]!;
      const dir = m.b.clone().sub(m.a).normalize();
      const dirPrev = prev.b.clone().sub(prev.a).normalize();
      const dirNext = next.b.clone().sub(next.a).normalize();
      const edgeLen = m.a.distanceTo(m.b);
      const maxExt = Math.max(1.2, edgeLen * 0.6);
      const safePoint = (base: THREE.Vector2, candidate: THREE.Vector2 | null, sign: -1 | 1) => {
        if (!candidate) return base.clone().addScaledVector(dir, fallbackHalfLen * sign);
        const rel = candidate.clone().sub(base);
        const t = rel.dot(dir);
        if (!Number.isFinite(t) || Math.abs(t) > maxExt) {
          return base.clone().addScaledVector(dir, fallbackHalfLen * sign);
        }
        return candidate;
      };
      const footRight = safePoint(m.foot, intersectLines(m.foot, dir, next.foot, dirNext), 1);
      const cornerRight = safePoint(m.corner, intersectLines(m.corner, dir, next.corner, dirNext), 1);
      outer[i] = footRight;
      inner[i] = cornerRight;
    }
    if (outer.length < 3 || inner.length < 3) return null;
    const outerArea = signedArea2(outer);
    const innerArea = signedArea2(inner);
    const outerRing = outerArea >= 0 ? outer : [...outer].reverse();
    const innerRing = innerArea >= 0 ? [...inner].reverse() : inner;

    const shape = new THREE.Shape();
    const outerW = outerRing.map(mathToWorld);
    const innerW = innerRing.map(mathToWorld);
    shape.moveTo(outerW[0]!.x, outerW[0]!.y);
    for (let i = 1; i < outerW.length; i += 1) shape.lineTo(outerW[i]!.x, outerW[i]!.y);
    const hole = new THREE.Path();
    hole.moveTo(innerW[0]!.x, innerW[0]!.y);
    for (let i = 1; i < innerW.length; i += 1) hole.lineTo(innerW[i]!.x, innerW[i]!.y);
    shape.holes.push(hole);

    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = TERRAIN_WORLD_Y_OFFSET + 0.085;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [edgeMeasurements]);

  const edgeMeasurementContourLines = useMemo(() => {
    if (!edgeMeasurements.length) return [] as Array<{ key: string; points: THREE.Vector3[]; violation: boolean }>;
    const out: Array<{ key: string; points: THREE.Vector3[]; violation: boolean }> = [];
    const n = edgeMeasurements.length;
    const fallbackHalfLen = 0.8;
    for (let i = 0; i < n; i += 1) {
      const m = edgeMeasurements[i]!;
      const prev = edgeMeasurements[(i - 1 + n) % n]!;
      const next = edgeMeasurements[(i + 1) % n]!;
      const dir = m.b.clone().sub(m.a).normalize();
      const dirPrev = prev.b.clone().sub(prev.a).normalize();
      const dirNext = next.b.clone().sub(next.a).normalize();
      const edgeLen = m.a.distanceTo(m.b);
      const maxExt = Math.max(1.2, edgeLen * 0.6);

      const safePoint = (base: THREE.Vector2, candidate: THREE.Vector2 | null, sign: -1 | 1) => {
        if (!candidate) return base.clone().addScaledVector(dir, fallbackHalfLen * sign);
        const rel = candidate.clone().sub(base);
        const t = rel.dot(dir); // extension along whisker direction
        if (!Number.isFinite(t) || Math.abs(t) > maxExt) {
          return base.clone().addScaledVector(dir, fallbackHalfLen * sign);
        }
        return candidate;
      };

      // Foot-side whisker: extend to intersections with neighboring foot whiskers.
      const footLeft = safePoint(m.foot, intersectLines(m.foot, dir, prev.foot, dirPrev), -1);
      const footRight = safePoint(m.foot, intersectLines(m.foot, dir, next.foot, dirNext), 1);

      // Corner-side whisker: extend to intersections with neighboring corner whiskers.
      const cornerLeft = safePoint(m.corner, intersectLines(m.corner, dir, prev.corner, dirPrev), -1);
      const cornerRight = safePoint(m.corner, intersectLines(m.corner, dir, next.corner, dirNext), 1);

      const footLeftW = mathToWorld(footLeft);
      const footRightW = mathToWorld(footRight);
      const cornerLeftW = mathToWorld(cornerLeft);
      const cornerRightW = mathToWorld(cornerRight);
      const yFootL = TERRAIN_WORLD_Y_OFFSET + 0.1;
      const yFootR = TERRAIN_WORLD_Y_OFFSET + 0.1;
      const yCornerL = TERRAIN_WORLD_Y_OFFSET + 0.1;
      const yCornerR = TERRAIN_WORLD_Y_OFFSET + 0.1;

      out.push({
        key: `edge-cap-foot-${m.edgeIndex}`,
        points: [
          new THREE.Vector3(footLeftW.x, yFootL, footLeftW.y),
          new THREE.Vector3(footRightW.x, yFootR, footRightW.y),
        ],
        violation: m.violation,
      });
      out.push({
        key: `edge-cap-corner-${m.edgeIndex}`,
        points: [
          new THREE.Vector3(cornerLeftW.x, yCornerL, cornerLeftW.y),
          new THREE.Vector3(cornerRightW.x, yCornerR, cornerRightW.y),
        ],
        violation: m.violation,
      });
    }
    return out;
  }, [edgeMeasurements]);

  const houseToParcelSideMeasurements = useMemo(() => {
    const parcelRingRender = ring2.map((p) => p.clone());
    if (activeModelFootprintRender.length < 2 || parcelRingRender.length < 2) {
      return [] as Array<{
        key: string;
        edgeIndex: number;
        line: [THREE.Vector3, THREE.Vector3];
        distance: number;
        labelPos: THREE.Vector3;
        points: [THREE.Vector3, THREE.Vector3];
      }>;
    }
    const out: Array<{
      key: string;
      edgeIndex: number;
      line: [THREE.Vector3, THREE.Vector3];
      distance: number;
      labelPos: THREE.Vector3;
      points: [THREE.Vector3, THREE.Vector3];
    }> = [];
    const hn = activeModelFootprintRender.length;
    const pn = parcelRingRender.length;
    for (let i = 0; i < pn; i += 1) {
      const pA = parcelRingRender[i]!;
      const pB = parcelRingRender[(i + 1) % pn]!;

      let best = {
        a: pA.clone(),
        b: activeModelFootprint2[0]!.clone(),
        dist: Number.POSITIVE_INFINITY,
      };

      for (let j = 0; j < hn; j += 1) {
        const hA = activeModelFootprintRender[j]!;
        const hB = activeModelFootprintRender[(j + 1) % hn]!;
        const cp = closestPointsSegmentToSegment2(pA, pB, hA, hB);
        if (cp.dist < best.dist) best = cp;
      }

      if (!Number.isFinite(best.dist)) continue;
      const bestFootPoint = best.a; // гарантированно на границе участка
      const bestHousePoint = best.b; // гарантированно на границе дома
      const y = TERRAIN_WORLD_Y_OFFSET + BORDER_SURFACE_OFFSET + 0.002;
      const a3 = new THREE.Vector3(bestHousePoint.x, y, bestHousePoint.y);
      const b3 = new THREE.Vector3(bestFootPoint.x, y, bestFootPoint.y);
      const mid = a3.clone().add(b3).multiplyScalar(0.5);
      out.push({
        key: `parcel-house-perp-${i}`,
        edgeIndex: i,
        line: [a3, b3],
        distance: best.dist,
        labelPos: mid,
        points: [a3, b3],
      });
    }
    return out;
  }, [activeModelFootprintRender, ring2]);

  const houseFootprintFillGeometry = useMemo(() => {
    if (activeModelFootprintRender.length < 3) return null;
    // ShapeGeometry создается в XY и после rotateX(-90) инвертирует знак оси Z.
    // Поэтому используем (x, -z), чтобы в world-space заливка совпала с контуром (x, z).
    const shapeRing = activeModelFootprintRender.map((p) => new THREE.Vector2(p.x, -p.y));
    const area = signedArea2(shapeRing);
    const ring = area >= 0 ? shapeRing : [...shapeRing].reverse();
    const shape = new THREE.Shape();
    shape.moveTo(ring[0]!.x, ring[0]!.y);
    for (let i = 1; i < ring.length; i += 1) shape.lineTo(ring[i]!.x, ring[i]!.y);
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = TERRAIN_WORLD_Y_OFFSET + 0.12;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [activeModelFootprintRender]);

  const setbackBands = useMemo(() => {
    if (ring2.length < 2) {
      return [] as Array<{ edgeIndex: number; band: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2]; violation: boolean }>;
    }
    const distanceByEdge = new Map(houseToParcelSideMeasurements.map((m) => [m.edgeIndex, m.distance] as const));
    const bands: Array<{ edgeIndex: number; band: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2]; violation: boolean }> = [];
    for (let edgeIndex = 0; edgeIndex < ring2.length; edgeIndex += 1) {
      const a = ring2[edgeIndex]!;
      const b = ring2[(edgeIndex + 1) % ring2.length]!;
      const dir = b.clone().sub(a).normalize();
      const inward = ccw ? new THREE.Vector2(-dir.y, dir.x) : new THREE.Vector2(dir.y, -dir.x);
      const setback = edgeIndex === streetLineIndex ? SETBACK_STREET_LINE_M : SETBACK_SIDE_M;
      const a2 = a.clone().addScaledVector(inward, setback);
      const b2 = b.clone().addScaledVector(inward, setback);
      const bandPoly: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2] = [a, b, b2, a2];
      const distance = distanceByEdge.get(edgeIndex);
      const violation = typeof distance === "number" ? distance + 1e-4 < setback : false;
      bands.push({
        edgeIndex,
        band: bandPoly,
        violation,
      });
    }
    return bands;
  }, [ring2, ccw, streetLineIndex, houseToParcelSideMeasurements]);

  const setbackBandGeometries = useMemo(() => {
    if (!setbackBands.length) return [] as Array<{ key: string; geometry: THREE.ShapeGeometry; violation: boolean }>;
    const out: Array<{ key: string; geometry: THREE.ShapeGeometry; violation: boolean }> = [];
    for (const item of setbackBands) {
      const [a, b, b2, a2] = item.band;
      const points = [a, b, b2, a2].map(mathToWorld);
      const shape = new THREE.Shape();
      shape.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i]!.x, points[i]!.y);
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i += 1) {
        pos.setY(i, TERRAIN_WORLD_Y_OFFSET + VIOLATION_HATCH_OFFSET);
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
      out.push({ key: `setback-band-${item.edgeIndex}`, geometry: g, violation: item.violation });
    }
    return out;
  }, [setbackBands]);

  const zone2 = useMemo(() => {
    if (ring2.length < 3 || streetLineIndex < 0) return [] as THREE.Vector2[];
    const area = signedArea2(ring2);
    const ccw = area >= 0;
    let clipped = ring2.map((p) => p.clone());
    for (let i = 0; i < ring2.length; i += 1) {
      const a = ring2[i]!;
      const b = ring2[(i + 1) % ring2.length]!;
      const dir = b.clone().sub(a).normalize();
      const inward = ccw ? new THREE.Vector2(-dir.y, dir.x) : new THREE.Vector2(dir.y, -dir.x);
      const setback = i === streetLineIndex ? SETBACK_STREET_LINE_M : SETBACK_SIDE_M;
      const offsetLinePoint = a.clone().addScaledVector(inward, setback);
      clipped = clipPolygonByHalfPlane(clipped, offsetLinePoint, dir);
      if (clipped.length < 3) return [] as THREE.Vector2[];
    }
    return clipped;
  }, [streetLineIndex, ring2]);

  const zoneGeometry = useMemo(() => {
    if (zone2.length < 3) return null;
    const shape = new THREE.Shape();
    shape.moveTo(zone2[0]!.x, zone2[0]!.y);
    for (let i = 1; i < zone2.length; i += 1) {
      shape.lineTo(zone2[i]!.x, zone2[i]!.y);
    }
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = TERRAIN_WORLD_Y_OFFSET + ZONE_SURFACE_OFFSET;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [zone2]);

  const violationZoneGeometry = useMemo(() => {
    if (!hasViolation || ring2.length < 3 || zone2.length < 3) return null;
    const shape = new THREE.Shape();
    shape.moveTo(ring2[0]!.x, ring2[0]!.y);
    for (let i = 1; i < ring2.length; i += 1) shape.lineTo(ring2[i]!.x, ring2[i]!.y);
    const hole = new THREE.Path();
    hole.moveTo(zone2[0]!.x, zone2[0]!.y);
    for (let i = 1; i < zone2.length; i += 1) hole.lineTo(zone2[i]!.x, zone2[i]!.y);
    shape.holes.push(hole);

    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = TERRAIN_WORLD_Y_OFFSET + VIOLATION_HATCH_OFFSET;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [hasViolation, ring2, zone2]);

  const violationHatchTexture = useMemo(() => {
    if (typeof document === "undefined") return null;
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(251,113,133,0.92)";
    ctx.lineWidth = 3;
    const step = 18;
    for (let x = -size; x <= size * 2; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, size);
      ctx.lineTo(x + size, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(5, 5);
    tex.needsUpdate = true;
    return tex;
  }, []);

  useEffect(
    () => () => {
      zoneGeometry?.dispose();
      measurementContourGeometry?.dispose();
      houseFootprintFillGeometry?.dispose();
      violationZoneGeometry?.dispose();
      violationHatchTexture?.dispose();
      for (const item of setbackBandGeometries) item.geometry.dispose();
    },
    [zoneGeometry, measurementContourGeometry, houseFootprintFillGeometry, violationZoneGeometry, violationHatchTexture, setbackBandGeometries],
  );

  const outlinePoints = useMemo(() => {
    if (ring2.length < 2) return [] as THREE.Vector3[];
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < ring2.length; i += 1) {
      const seg = [ring2[i]!, ring2[(i + 1) % ring2.length]!];
      const maxJ = i === ring2.length - 1 ? seg.length - 1 : seg.length - 2;
      for (let j = 0; j <= maxJ; j += 1) {
        const p = seg[j]!;
        const y = TERRAIN_WORLD_Y_OFFSET + BORDER_SURFACE_OFFSET;
        points.push(new THREE.Vector3(p.x, y, p.y));
      }
    }
    if (points.length > 0) points.push(points[0].clone());
    return points;
  }, [ring2]);

  const streetLinePoints = useMemo(() => {
    if (ring2.length < 2 || streetLineIndex < 0) return [] as THREE.Vector3[];
    const a = ring2[streetLineIndex]!;
    const b = ring2[(streetLineIndex + 1) % ring2.length]!;
    const seg = [a, b];
    return seg.map((p) => {
      const y = TERRAIN_WORLD_Y_OFFSET + BORDER_SURFACE_OFFSET + 0.01;
      return new THREE.Vector3(p.x, y, p.y);
    });
  }, [streetLineIndex, ring2]);

  const zoneOutlinePoints = useMemo(() => {
    if (zone2.length < 3) return [] as THREE.Vector3[];
    const points = zone2.map((p) => {
      const y = TERRAIN_WORLD_Y_OFFSET + ZONE_BORDER_OFFSET;
      return new THREE.Vector3(p.x, y, p.y);
    });
    points.push(points[0]!.clone());
    return points;
  }, [zone2]);

  if (!parcel || outlinePoints.length < 2) return null;

  return (
    <group>
      {setbackBandGeometries.map((item) => (
        <mesh key={item.key} geometry={item.geometry} renderOrder={9} frustumCulled={false}>
          <meshStandardMaterial
            color={item.violation ? "#ef4444" : "#22c55e"}
            transparent
            opacity={0.3}
            depthWrite={false}
          />
        </mesh>
      ))}
      <Line
        points={outlinePoints}
        color="#ffd400"
        lineWidth={2}
        dashed={false}
        renderOrder={12}
        depthTest
        transparent={false}
        opacity={1}
      />
      {streetLinePoints.length > 1 ? (
        <Line
          points={streetLinePoints}
          color="#ef4444"
          lineWidth={3}
          dashed={false}
          renderOrder={14}
          depthTest
        />
      ) : null}
    </group>
  );
}
