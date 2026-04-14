import { NextRequest, NextResponse } from "next/server";
import * as https from "node:https";

function requestText(url: string, rejectUnauthorized: boolean): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Referer: "https://nspd.gov.ru/map",
          "User-Agent":
            "Mozilla/5.0 (compatible; Gravio/0.1; +https://nspd.gov.ru) AppleWebKit/537.36",
        },
        rejectUnauthorized,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Прокси к поиску НСПД (тот же endpoint, что и карта nspd.gov.ru). */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Укажите параметр q (кадастровый номер)." }, { status: 400 });
  }

  const upstream = new URL("https://nspd.gov.ru/api/geoportal/v2/search/geoportal");
  upstream.searchParams.set("thematicSearchId", "1");
  upstream.searchParams.set("query", q);

  try {
    let status = 0;
    let text = "";
    try {
      const strict = await requestText(upstream.toString(), true);
      status = strict.status;
      text = strict.body;
    } catch (firstError) {
      // Retry с ослабленной проверкой TLS только для этого исследовательского прокси.
      const fallback = await requestText(upstream.toString(), false);
      status = fallback.status;
      text = fallback.body;
    }
    if (status < 200 || status >= 300) {
      return NextResponse.json(
        {
          error: "Ответ НСПД неуспешен",
          status,
          detail: text.slice(0, 800),
        },
        { status: 502 },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return NextResponse.json({ error: "Некорректный JSON от НСПД" }, { status: 502 });
    }

    return NextResponse.json(json);
  } catch (e) {
    const message = e instanceof Error ? e.message : "fetch failed";
    const cause =
      e && typeof e === "object" && "cause" in e
        ? String((e as { cause?: unknown }).cause)
        : null;
    return NextResponse.json(
      {
        error: "Не удалось выполнить запрос к НСПД",
        detail: cause ? `${message}; cause=${cause}` : message,
      },
      { status: 502 },
    );
  }
}
