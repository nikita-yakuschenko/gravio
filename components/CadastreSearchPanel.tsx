"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getFirstLandFeature, isPolygonGeometry } from "@/lib/cadastre/nspdSearch";
import type { NspdSearchResponse } from "@/lib/cadastre/nspdSearch";
import { useParcelBaseStore } from "@/store/parcelBaseStore";
const PREVIEW_SIZE_PX = 180;
const PREVIEW_PADDING_PX = 14;

type P2 = { x: number; y: number };

function angleDegAtVertex(prev: P2, curr: P2, next: P2): number {
  const ax = prev.x - curr.x;
  const ay = prev.y - curr.y;
  const bx = next.x - curr.x;
  const by = next.y - curr.y;
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(dot) * 180) / Math.PI;
}

function simplifyNearStraightEdges(points: P2[], minAngleDeg: number, maxAngleDeg: number): P2[] {
  if (points.length < 4) return points.slice();
  let out = points.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const nextOut: P2[] = [];
    for (let i = 0; i < out.length; i += 1) {
      const prev = out[(i - 1 + out.length) % out.length]!;
      const curr = out[i]!;
      const next = out[(i + 1) % out.length]!;
      const angle = angleDegAtVertex(prev, curr, next);
      const nearStraight = angle >= minAngleDeg && angle <= maxAngleDeg;
      if (nearStraight && out.length > 3) {
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

function buildPreviewPoints(ringClosedXZ: [number, number][]): P2[] {
  // X is east, Z is north -> mini-map keeps north-up and east-right.
  const raw = ringClosedXZ.slice(0, -1).map(([x, z]) => ({ x, y: z }));
  const simplified = simplifyNearStraightEdges(raw, 178, 182);
  if (simplified.length < 3) return [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of simplified) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const drawSize = PREVIEW_SIZE_PX - PREVIEW_PADDING_PX * 2;
  const scale = drawSize / Math.max(spanX, spanY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const mid = PREVIEW_SIZE_PX / 2;
  return simplified.map((p) => ({
    x: mid + (p.x - centerX) * scale,
    y: mid - (p.y - centerY) * scale,
  }));
}

function edgeLength(a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function CadastreSearchPanel() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const parcel = useParcelBaseStore((s) => s.parcel);
  const applyFeature = useParcelBaseStore((s) => s.applyFeature);
  const clearParcel = useParcelBaseStore((s) => s.clear);
  const streetLineEdgeIndex = useParcelBaseStore((s) => s.streetLineEdgeIndex);
  const setStreetLineEdgeIndex = useParcelBaseStore((s) => s.setStreetLineEdgeIndex);

  const previewPoints = useMemo(
    () => (parcel?.ringClosedXZ?.length ? buildPreviewPoints(parcel.ringClosedXZ) : []),
    [parcel?.ringClosedXZ],
  );

  const applyFromPayload = useCallback(
    (json: NspdSearchResponse) => {
      const feature = getFirstLandFeature(json);
      if (!feature) {
        setError("Объекты не найдены. Проверьте номер.");
        return false;
      }
      if (!isPolygonGeometry(feature.geometry)) {
        setError("Для найденного объекта нет полигона границы.");
        return false;
      }
      applyFeature(feature);
      return true;
    },
    [applyFeature],
  );

  const onSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setError("Введите кадастровый номер.");
      return;
    }
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const directUrl = new URL("https://nspd.gov.ru/api/geoportal/v2/search/geoportal");
      directUrl.searchParams.set("thematicSearchId", "1");
      directUrl.searchParams.set("query", q);
      // Шаг 1: пытаемся получить данные напрямую из браузера (IP пользователя).
      try {
        const browserRes = await fetch(directUrl.toString(), {
          method: "GET",
          mode: "cors",
          credentials: "include",
          cache: "no-store",
        });
        const browserJson = (await browserRes.json()) as NspdSearchResponse;
        if (browserRes.ok && applyFromPayload(browserJson)) {
          setInfo("Геометрия получена прямым запросом из браузера.");
          return;
        }
      } catch {
        // Падаем в серверный прокси.
      }

      // Шаг 2: fallback через серверный прокси.
      const res = await fetch(`/api/cadastre/search?q=${encodeURIComponent(q)}`);
      const json = (await res.json()) as NspdSearchResponse & { error?: string; detail?: string };
      if (res.ok && applyFromPayload(json)) {
        setInfo("Геометрия получена через серверный прокси (fallback).");
        return;
      }

      setError(
        json.detail
          ? `${json.error ?? `Запрос не удался (${res.status})`}: ${json.detail}`
          : (json.error ?? `Запрос не удался (${res.status})`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Сеть недоступна.");
    } finally {
      setBusy(false);
    }
  }, [applyFromPayload, query]);

  return (
    <div className="space-y-2 border-b border-slate-800 p-3">
      <p className="text-xs font-medium text-slate-300">Кадастровая подложка</p>
      <p className="text-[11px] leading-snug text-slate-500">
        Поиск через НСПД: участок центрируется в сцене, граница — основа под IFC.
      </p>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void onSearch()}
          placeholder="52:24:0110001:11553"
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-cyan-600 focus:outline-none"
        />
        <Button type="button" size="sm" disabled={busy} onClick={() => void onSearch()}>
          {busy ? "…" : "Найти"}
        </Button>
      </div>
      {info ? <p className="text-[11px] text-emerald-300">{info}</p> : null}
      {error ? <p className="text-[11px] text-red-400">{error}</p> : null}
      {parcel ? (
        <>
          <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-[11px] text-slate-300">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Участок</p>
            <p className="mt-1 font-medium text-sky-200">{parcel.cadNum}</p>
            {parcel.address ? <p className="mt-0.5 text-slate-400">{parcel.address}</p> : null}
            {parcel.specifiedAreaM2 != null ? (
              <p className="mt-1 text-slate-400">Площадь (ЕГРН): {parcel.specifiedAreaM2.toLocaleString("ru-RU")} м²</p>
            ) : null}
            {previewPoints.length >= 3 ? (
              <div className="mt-2 rounded-md border border-slate-700/70 bg-slate-950/40 p-2">
                <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Выбор красной линии</p>
                <svg
                  width={PREVIEW_SIZE_PX}
                  height={PREVIEW_SIZE_PX}
                  viewBox={`0 0 ${PREVIEW_SIZE_PX} ${PREVIEW_SIZE_PX}`}
                  className="h-auto w-full overflow-hidden rounded border border-slate-800 bg-slate-950/50"
                >
                  <g transform="translate(24,24)">
                    <circle cx={0} cy={0} r={12} fill="rgba(15,23,42,0.65)" stroke="#334155" strokeWidth={1} />
                    <line x1={0} y1={-8} x2={0} y2={8} stroke="#64748b" strokeWidth={1} />
                    <line x1={-8} y1={0} x2={8} y2={0} stroke="#64748b" strokeWidth={1} />
                    <polygon points="0,-9.5 1.8,-5.2 -1.8,-5.2" fill="#ef4444" />
                    <text x={0} y={-11} fill="#cbd5e1" fontSize={6} textAnchor="middle">
                      С
                    </text>
                    <text x={11} y={2} fill="#cbd5e1" fontSize={6} textAnchor="middle">
                      В
                    </text>
                    <text x={0} y={14} fill="#cbd5e1" fontSize={6} textAnchor="middle">
                      Ю
                    </text>
                    <text x={-11} y={2} fill="#cbd5e1" fontSize={6} textAnchor="middle">
                      З
                    </text>
                  </g>
                  <polygon
                    points={previewPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="rgba(14, 165, 233, 0.08)"
                    stroke="#fcd34d"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {previewPoints.map((a, i) => {
                    const b = previewPoints[(i + 1) % previewPoints.length]!;
                    const selected = streetLineEdgeIndex === i;
                    return (
                      <line
                        // eslint-disable-next-line react/no-array-index-key
                        key={`edge-preview-${i}`}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke={selected ? "#ef4444" : "transparent"}
                        strokeWidth={selected ? 4 : 2}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "pointer" }}
                        onClick={() => setStreetLineEdgeIndex(i)}
                      >
                        <title>{`Грань №${i + 1}, длина ~${edgeLength(a, b).toFixed(1)} усл. ед.`}</title>
                      </line>
                    );
                  })}
                  {previewPoints.map((a, i) => {
                    const b = previewPoints[(i + 1) % previewPoints.length]!;
                    return (
                      <line
                        // eslint-disable-next-line react/no-array-index-key
                        key={`edge-hit-${i}`}
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke="transparent"
                        strokeWidth={14}
                        vectorEffect="non-scaling-stroke"
                        style={{ cursor: "pointer" }}
                        onClick={() => setStreetLineEdgeIndex(i)}
                      />
                    );
                  })}
                </svg>
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-7 text-[11px] text-slate-400 hover:text-slate-200"
            onClick={() => clearParcel()}
          >
            Сбросить подложку
          </Button>
        </>
      ) : null}
    </div>
  );
}
