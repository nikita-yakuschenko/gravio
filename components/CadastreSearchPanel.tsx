"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { getFirstLandFeature, isPolygonGeometry } from "@/lib/cadastre/nspdSearch";
import type { NspdSearchResponse } from "@/lib/cadastre/nspdSearch";
import { useParcelBaseStore } from "@/store/parcelBaseStore";

export function CadastreSearchPanel() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const parcel = useParcelBaseStore((s) => s.parcel);
  const applyFeature = useParcelBaseStore((s) => s.applyFeature);
  const clearParcel = useParcelBaseStore((s) => s.clear);
  const terrainStatus = useParcelBaseStore((s) => s.terrainStatus);
  const terrainMessage = useParcelBaseStore((s) => s.terrainMessage);
  const terrainSource = useParcelBaseStore((s) => s.terrainSource);
  const terrainProviderPref = useParcelBaseStore((s) => s.terrainProviderPref);
  const setTerrainProviderPref = useParcelBaseStore((s) => s.setTerrainProviderPref);

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
          </div>

          <div className="relative rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-[11px] text-slate-300">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Рельеф</p>
            <div className="absolute right-2 top-2 flex items-center rounded-md border border-slate-700 bg-slate-900/85 p-0.5">
              <button
                type="button"
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  terrainProviderPref === "open-elevation"
                    ? "bg-cyan-600/20 text-cyan-100 ring-1 ring-cyan-500/40"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                onClick={() => setTerrainProviderPref("open-elevation")}
                title="Open-Elevation"
              >
                OE
              </button>
              <button
                type="button"
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  terrainProviderPref === "opentopodata"
                    ? "bg-cyan-600/20 text-cyan-100 ring-1 ring-cyan-500/40"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                onClick={() => setTerrainProviderPref("opentopodata")}
                title="OpenTopoData"
              >
                OTD
              </button>
            </div>
            <p
              className={`mt-1 ${
                terrainStatus === "ready"
                  ? "text-emerald-300"
                  : terrainStatus === "error"
                    ? "text-amber-300"
                    : "text-slate-400"
              }`}
            >
              {terrainStatus === "ready"
                ? "Загружен"
                : terrainStatus === "loading"
                  ? "Загружается"
                  : terrainStatus === "error"
                    ? "Не загружен"
                    : "Ожидание"}
            </p>
            {terrainSource ? <p className="mt-0.5 text-[10px] text-slate-500">Источник: {terrainSource}</p> : null}
            {terrainMessage ? <p className="mt-0.5 text-slate-500">{terrainMessage}</p> : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-2 h-7 text-[11px] text-slate-400 hover:text-slate-200"
              onClick={() => clearParcel()}
            >
              Сбросить подложку
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
