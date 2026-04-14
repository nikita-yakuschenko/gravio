import { NextRequest, NextResponse } from "next/server";

type ReqBody = {
  locations?: string[];
  dataset?: string;
  provider?: "open-elevation" | "opentopodata";
};

type OpenTopoDataResponse = {
  results?: Array<{
    elevation: number | null;
    location?: { lat?: number; lng?: number };
    dataset?: string;
  }>;
  status?: string;
};

type OpenElevationResponse = {
  results?: Array<{
    elevation: number | null;
    latitude?: number;
    longitude?: number;
  }>;
};

async function fetchOpenTopoData(locations: string[], dataset: string) {
  const url = `https://api.opentopodata.org/v1/${encodeURIComponent(dataset)}?locations=${encodeURIComponent(
    locations.join("|"),
  )}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenTopoData ${res.status}: ${text.slice(0, 200)}`);
  }
  let json: OpenTopoDataResponse;
  try {
    json = JSON.parse(text) as OpenTopoDataResponse;
  } catch {
    throw new Error("OpenTopoData invalid JSON");
  }
  return json;
}

async function fetchOpenElevation(locations: string[]) {
  const url = `https://api.open-elevation.com/api/v1/lookup?locations=${encodeURIComponent(
    locations.join("|"),
  )}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Open-Elevation ${res.status}: ${text.slice(0, 200)}`);
  }
  let json: OpenElevationResponse;
  try {
    json = JSON.parse(text) as OpenElevationResponse;
  } catch {
    throw new Error("Open-Elevation invalid JSON");
  }
  // Приводим к форме, совместимой с OpenTopoData (клиенту ничего менять не нужно).
  return {
    status: "OK",
    provider: "open-elevation",
    results: (json.results ?? []).map((row) => ({
      elevation: row.elevation ?? null,
      location: {
        lat: row.latitude,
        lng: row.longitude,
      },
      dataset: "open-elevation",
    })),
  };
}

export async function POST(req: NextRequest) {
  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: "Некорректный JSON тела запроса." }, { status: 400 });
  }

  const locations = body.locations?.filter((x) => typeof x === "string" && x.length > 0) ?? [];
  const dataset = (body.dataset || "srtm30m").trim();
  const preferredProvider = body.provider === "opentopodata" ? "opentopodata" : "open-elevation";
  if (!locations.length) {
    return NextResponse.json({ error: "Нужен непустой массив locations." }, { status: 400 });
  }
  if (locations.length > 100) {
    return NextResponse.json({ error: "Лимит OpenTopoData: максимум 100 точек за запрос." }, { status: 400 });
  }

  try {
    const first = preferredProvider;
    const second = first === "open-elevation" ? "opentopodata" : "open-elevation";

    try {
      if (first === "open-elevation") return NextResponse.json(await fetchOpenElevation(locations));
      const topoJson = await fetchOpenTopoData(locations, dataset);
      return NextResponse.json({ ...topoJson, provider: "opentopodata" });
    } catch (firstErr) {
      try {
        if (second === "open-elevation") return NextResponse.json(await fetchOpenElevation(locations));
        const topoJson = await fetchOpenTopoData(locations, dataset);
        return NextResponse.json({ ...topoJson, provider: "opentopodata" });
      } catch (secondErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
        return NextResponse.json(
          {
            error: "Не удалось получить рельеф от провайдеров.",
            detail: `${first}: ${firstMsg}; ${second}: ${secondMsg}`,
          },
          { status: 502 },
        );
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json({ error: `Ошибка запроса рельефа: ${msg}` }, { status: 502 });
  }
}
