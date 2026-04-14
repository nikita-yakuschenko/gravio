// Генерация SVG A4 из GeoJSON участка (EPSG:3857). Запуск: node scripts/render-cadastre-a4.cjs
const fs = require("fs");
const path = require("path");

const inPath = path.join(__dirname, "../research/cadastre-52-24-0110001-11553.geojson");
const outPath = path.join(__dirname, "../research/cadastre-52-24-0110001-11553.svg");

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shoelaceAreaM2(ring) {
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

function centroid(ring) {
  let x = 0,
    y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

const geo = JSON.parse(fs.readFileSync(inPath, "utf8"));
const ringClosed = geo.features[0].geometry.coordinates[0];
// Для шнурка убираем дублирующее замыкание (последняя точка = первой)
const ring =
  ringClosed.length > 2 &&
  ringClosed[0][0] === ringClosed[ringClosed.length - 1][0] &&
  ringClosed[0][1] === ringClosed[ringClosed.length - 1][1]
    ? ringClosed.slice(0, -1)
    : ringClosed.slice();
const props = geo.features[0].properties;

let minX = Infinity,
  minY = Infinity,
  maxX = -Infinity,
  maxY = -Infinity;
for (const [x, y] of ringClosed) {
  minX = Math.min(minX, x);
  maxX = Math.max(maxX, x);
  minY = Math.min(minY, y);
  maxY = Math.max(maxY, y);
}

const areaPlanar = shoelaceAreaM2(ring);
const [cx, cy] = centroid(ring);

// A4 в мм: 210 x 297
const pad = 12;
const titleBlock = 40;
const infoBlock = 60;
const mapTop = titleBlock;
const mapBottom = 297 - infoBlock;
const mapLeft = pad;
const mapRight = 210 - pad;
const mapW = mapRight - mapLeft;
const mapH = mapBottom - mapTop;

const dataW = maxX - minX;
const dataH = maxY - minY;
const s = Math.min(mapW / dataW, mapH / dataH) * 0.94;
const offX = mapLeft + (mapW - dataW * s) / 2;
const offY = mapTop + (mapH - dataH * s) / 2;

function tx(x) {
  return offX + (x - minX) * s;
}
function ty(y) {
  return offY + (maxY - y) * s;
}

const d = ringClosed
  .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${tx(x).toFixed(4)} ${ty(y).toFixed(4)}`)
  .join(" ")
  .concat(" Z");

const fmt = (n) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(n));

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">
  <rect fill="#ffffff" width="210" height="297"/>
  <text x="105" y="13" font-family="Segoe UI, Arial, sans-serif" font-size="8" text-anchor="middle" fill="#444">Выписка визуализации (НСПД, исследование)</text>
  <text x="105" y="28" font-family="Segoe UI, Arial, sans-serif" font-size="13" text-anchor="middle" font-weight="600">${esc(
    props.cad_num,
  )}</text>
  <text x="105" y="38" font-family="Segoe UI, Arial, sans-serif" font-size="6.3" text-anchor="middle" fill="#333">${esc(
    props.readable_address,
  )}</text>
  <rect x="${mapLeft}" y="${mapTop}" width="${mapW}" height="${mapH}" fill="#f4f7fa" stroke="#c5d4e0" stroke-width="0.25"/>
  <path d="${d}" fill="rgba(30,136,229,0.22)" stroke="#1565c0" stroke-width="0.28" fill-rule="evenodd"/>
  <text x="${tx(cx).toFixed(2)}" y="${ty(cy).toFixed(2)}" font-family="Segoe UI, Arial, sans-serif" font-size="4.5" text-anchor="middle" fill="#0d47a1" opacity="0.85">участок</text>
  <text x="${pad}" y="${mapBottom + 8}" font-family="Segoe UI, Arial, sans-serif" font-size="6.5" font-weight="600">Сведения</text>
  <text x="${pad}" y="${mapBottom + 16}" font-family="Segoe UI, Arial, sans-serif" font-size="5.2">Площадь по данным ЕГРН (specified_area): ${fmt(
    props.specified_area_m2,
  )} м²</text>
  <text x="${pad}" y="${mapBottom + 24}" font-family="Segoe UI, Arial, sans-serif" font-size="5.2">Площадь по контуру в плоскости EPSG:3857 (шнурок, не равна земной из‑за проекции): ${fmt(
    areaPlanar,
  )} м²</text>
  <text x="${pad}" y="${mapBottom + 32}" font-family="Segoe UI, Arial, sans-serif" font-size="5.2">Кадастровая стоимость: ${fmt(
    props.cost_value_rub,
  )} руб. · Удельный показатель: ${props.cost_index}</text>
  <text x="${pad}" y="${mapBottom + 40}" font-family="Segoe UI, Arial, sans-serif" font-size="5.2">Вид разрешённого использования: ${esc(
    props.permitted_use_established_by_document,
  )}</text>
  <text x="${pad}" y="${mapBottom + 48}" font-family="Segoe UI, Arial, sans-serif" font-size="5.2">Статус: ${esc(
    props.status,
  )} · Форма собственности: ${esc(props.ownership_type)}</text>
  <text x="${pad}" y="${mapBottom + 56}" font-family="Segoe UI, Arial, sans-serif" font-size="4.8" fill="#666">Координаты контура — EPSG:3857. Источник: ${esc(
    props.source,
  )}</text>
  <text x="${210 - pad}" y="${291}" font-family="Segoe UI, Arial, sans-serif" font-size="4.5" text-anchor="end" fill="#888">Масштаб подогнан под поле карты · А4 портрет</text>
</svg>
`;

fs.writeFileSync(outPath, svg, "utf8");
console.log("Written:", outPath);
console.log("Площадь (шнурок EPSG:3857):", Math.round(areaPlanar), "м²");
console.log("Площадь ЕГРН:", props.specified_area_m2, "м²");
