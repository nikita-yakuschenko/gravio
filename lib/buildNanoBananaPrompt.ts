import type { IfcModelItem } from "@/types/ifc";
import { VIEWPORT_OUTDOOR_SPEC } from "@/lib/viewportOutdoorSpec";
import type {
  BuildNanoBananaPromptInput,
  NanoBananaCameraSnapshot,
  NanoBananaParcelContext,
  PlacedModelSnapshot,
} from "@/lib/nanoBananaTypes";

export type { BuildNanoBananaPromptInput, NanoBananaCameraSnapshot, PlacedModelSnapshot };

/** Жёсткий лимит длины строки промпта для генераторов (символов Unicode). */
export const MAX_NANO_BANANA_PROMPT_CHARS = 10000;

/** Запас под поля meta (promptMaxChars, promptTextBudgetPerField, …) после ужимания текста. */
const RESERVED_FOR_FINAL_META = 380;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function detectMasterplanLinearPattern(
  points: Array<{ x: number; z: number }>,
): boolean {
  if (points.length < 3) return false;
  const n = points.length;
  let meanX = 0;
  let meanZ = 0;
  for (const p of points) {
    meanX += p.x;
    meanZ += p.z;
  }
  meanX /= n;
  meanZ /= n;

  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dz = p.z - meanZ;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  sxx /= n;
  szz /= n;
  sxz /= n;

  const trace = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const disc = Math.max(trace * trace - 4 * det, 0);
  const sqrtDisc = Math.sqrt(disc);
  const l1 = Math.max((trace + sqrtDisc) * 0.5, 0);
  const l2 = Math.max((trace - sqrtDisc) * 0.5, 0);
  if (l1 <= 1e-9) return false;

  const anisotropy = l2 / l1;
  const majorSpan = Math.sqrt(l1) * 2;
  return anisotropy < 0.2 && majorSpan >= 12;
}

function buildParcelRenderNote(parcel?: NanoBananaParcelContext): string | null {
  if (!parcel) return null;
  const areaPart =
    typeof parcel.specifiedAreaM2 === "number" && Number.isFinite(parcel.specifiedAreaM2)
      ? `площадь участка ориентировочно ${Math.round(parcel.specifiedAreaM2)} м²`
      : "площадь участка не уточнена";
  const scalePart =
    typeof parcel.fitRadiusM === "number" && Number.isFinite(parcel.fitRadiusM)
      ? `масштаб сцены: радиус участка около ${round6(parcel.fitRadiusM)} м (диаметр около ${round6(parcel.fitRadiusM * 2)} м)`
      : "масштаб сцены брать строго из метрик участка в метрах";
  return `Сцена в режиме участка: ${areaPart}, ${scalePart}.`;
}

function truncatePromptText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars));
}

type GravioSceneShape = {
  architecturalModels?: Array<{
    reconstructionPromptRu?: string;
    reconstructionPromptEn?: string;
    geometryMesh?: unknown;
    ifcAnalysis?: unknown;
  }>;
  reconstruction?: {
    summaryRu?: string;
    summaryEn?: string;
    perModelPrompts?: unknown;
  };
};

/** Убирает дубликаты и тяжёлые необязательные поля перед подсчётом длины. */
function preparePayloadForPromptSizing(payload: Record<string, unknown>): void {
  const g = payload.gravio as { scene?: GravioSceneShape } | undefined;
  const s = g?.scene;
  if (!s) return;
  // Дублирует тексты из architecturalModels — экономим место при ужимании.
  if (s.reconstruction && "perModelPrompts" in s.reconstruction) {
    delete s.reconstruction.perModelPrompts;
  }
  const models = s.architecturalModels;
  if (!models) return;
  for (const m of models) {
    delete m.geometryMesh;
    delete m.ifcAnalysis;
  }
}

function applyTextBudgetToPayload(payload: Record<string, unknown>, maxCharsPerField: number): void {
  const ng = payload.narrative_guide as { ru?: string; en?: string } | undefined;
  if (ng?.ru) ng.ru = truncatePromptText(ng.ru, maxCharsPerField);
  if (ng?.en) ng.en = truncatePromptText(ng.en, maxCharsPerField);

  const scene = (payload.gravio as { scene?: GravioSceneShape } | undefined)?.scene;
  if (scene?.reconstruction) {
    const r = scene.reconstruction;
    if (r.summaryRu) r.summaryRu = truncatePromptText(r.summaryRu, maxCharsPerField + 400);
    if (r.summaryEn) r.summaryEn = truncatePromptText(r.summaryEn, maxCharsPerField + 400);
  }
  const models = scene?.architecturalModels;
  if (models) {
    for (const m of models) {
      if (m.reconstructionPromptRu)
        m.reconstructionPromptRu = truncatePromptText(m.reconstructionPromptRu, maxCharsPerField);
      if (m.reconstructionPromptEn)
        m.reconstructionPromptEn = truncatePromptText(m.reconstructionPromptEn, maxCharsPerField);
    }
  }
}

function compactJsonLength(payload: Record<string, unknown>): number {
  return JSON.stringify(payload).length;
}

/** Длина строки, если её вставляют как JSON-строку (с экранированием). */
function escapedStringLength(s: string): number {
  return Math.max(0, JSON.stringify(s).length - 2);
}

/** Длина при двойном экранировании (частый кейс: prompts:"<json-string>"). */
function doubleEscapedStringLength(s: string): number {
  return Math.max(0, JSON.stringify(JSON.stringify(s)).length - 4);
}

/**
 * Подбирает максимальный лимит символов на текстовое поле так, чтобы JSON без отступов
 * укладывался в maxTotalChars.
 */
function maxTextBudgetForCompactJson(payload: Record<string, unknown>, maxTotalChars: number): number {
  let lo = 0;
  let hi = 12000;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const trial = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    applyTextBudgetToPayload(trial, mid);
    if (compactJsonLength(trial) <= maxTotalChars) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

type MinimalArch = {
  id: string;
  name: string;
  placement: unknown;
  localRootBounds: unknown;
  reconstructionPromptRu: string;
  reconstructionPromptEn: string;
};

/** Крайний случай: только ключевые поля по моделям (лимиты подбираются снаружи). */
function buildEmergencyMinimalPayload(
  source: Record<string, unknown>,
  limits: {
    objective: number;
    narrative: number;
    modelRu: number;
    modelEn: number;
  },
): Record<string, unknown> {
  const g = source.gravio as {
    environment?: unknown;
    camera_detail?: unknown;
    scene?: GravioSceneShape & { placedModels?: unknown };
    generation?: unknown;
  };
  const models = g?.scene?.architecturalModels ?? [];
  const tiny: MinimalArch[] = models.map((m) => ({
    id: String((m as { id?: string }).id ?? ""),
    name: String((m as { name?: string }).name ?? ""),
    placement: (m as { placement?: unknown }).placement,
    localRootBounds: (m as { localRootBounds?: unknown }).localRootBounds,
    reconstructionPromptRu: truncatePromptText(String((m as { reconstructionPromptRu?: string }).reconstructionPromptRu ?? ""), limits.modelRu),
    reconstructionPromptEn: truncatePromptText(String((m as { reconstructionPromptEn?: string }).reconstructionPromptEn ?? ""), limits.modelEn),
  }));
  return {
    prompt_type: source.prompt_type,
    version: source.version,
    objective: truncatePromptText(String(source.objective ?? ""), limits.objective),
    strict_requirements: source.strict_requirements,
    creative_enhancement: source.creative_enhancement,
    narrative_guide: {
      ru: truncatePromptText(String((source.narrative_guide as { ru?: string })?.ru ?? ""), limits.narrative),
      en: truncatePromptText(String((source.narrative_guide as { en?: string })?.en ?? ""), limits.narrative),
    },
    source_scene: source.source_scene,
    camera: source.camera,
    render_style: source.render_style,
    meta: {
      ...(source.meta as object),
      promptMaxChars: MAX_NANO_BANANA_PROMPT_CHARS,
      promptEmergencyMinimal: true,
    },
    gravio: {
      environment: g?.environment,
      camera_detail: g?.camera_detail,
      scene: {
        units: "meters",
        placedModels: g?.scene?.placedModels,
        architecturalModels: tiny,
      },
      generation: g?.generation,
    },
  };
}

function shrinkEmergencyUntilFits(source: Record<string, unknown>): Record<string, unknown> {
  const cap = MAX_NANO_BANANA_PROMPT_CHARS - RESERVED_FOR_FINAL_META;
  const tiers = [
    { objective: 900, narrative: 1200, modelRu: 400, modelEn: 400 },
    { objective: 600, narrative: 800, modelRu: 280, modelEn: 280 },
    { objective: 400, narrative: 500, modelRu: 180, modelEn: 180 },
    { objective: 280, narrative: 320, modelRu: 120, modelEn: 120 },
    { objective: 200, narrative: 220, modelRu: 80, modelEn: 80 },
    { objective: 120, narrative: 140, modelRu: 50, modelEn: 50 },
  ];
  for (const lim of tiers) {
    const p = buildEmergencyMinimalPayload(source, lim);
    if (compactJsonLength(p) <= cap) return p;
  }
  return buildEmergencyMinimalPayload(source, { objective: 80, narrative: 100, modelRu: 40, modelEn: 40 });
}

/**
 * Сериализует промпт с гарантией: длина строки ≤ MAX_NANO_BANANA_PROMPT_CHARS.
 * Сначала сохраняется максимум текста (бинарный поиск лимита полей), затем при необходимости — компактный JSON.
 */
export function finalizeNanoBananaPromptString(payload: Record<string, unknown>): string {
  const base = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  preparePayloadForPromptSizing(base);

  const uncompressedCompactLen = compactJsonLength(base);
  const budget = maxTextBudgetForCompactJson(
    base,
    MAX_NANO_BANANA_PROMPT_CHARS - RESERVED_FOR_FINAL_META,
  );
  applyTextBudgetToPayload(base, budget);

  let working: Record<string, unknown> = base;
  let usedEmergency = false;
  if (compactJsonLength(working) > MAX_NANO_BANANA_PROMPT_CHARS - RESERVED_FOR_FINAL_META) {
    working = shrinkEmergencyUntilFits(working);
    usedEmergency = true;
  }

  const meta = (working.meta as Record<string, unknown> | undefined) ?? {};
  working.meta = {
    ...meta,
    promptMaxChars: MAX_NANO_BANANA_PROMPT_CHARS,
    promptTextBudgetPerField: budget,
    promptTruncated: uncompressedCompactLen > MAX_NANO_BANANA_PROMPT_CHARS || usedEmergency,
    promptEmergencyMinimal: usedEmergency,
  };

  let compact = JSON.stringify(working);
  // На случай если служебные поля meta пересекли лимит — укорачиваем meta (без поломки JSON).
  if (compact.length > MAX_NANO_BANANA_PROMPT_CHARS) {
    const m = working.meta as Record<string, unknown>;
    delete m.promptTextBudgetPerField;
    compact = JSON.stringify(working);
  }
  const pretty = JSON.stringify(working, null, 2);
  let out = pretty.length <= MAX_NANO_BANANA_PROMPT_CHARS ? pretty : compact;

  // Внешние сервисы часто ожидают prompt как значение JSON-поля (строка с экранированием).
  // Поэтому проверяем и этот вариант длины.
  if (
    escapedStringLength(out) <= MAX_NANO_BANANA_PROMPT_CHARS &&
    doubleEscapedStringLength(out) <= MAX_NANO_BANANA_PROMPT_CHARS
  ) {
    return out;
  }

  // Агрессивное ужатие под экранированный лимит.
  const factors = [0.55, 0.4, 0.28, 0.2, 0.14, 0.1, 0.07];
  for (const factor of factors) {
    const trial = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const tighterBudget = Math.max(20, Math.floor(budget * factor));
    applyTextBudgetToPayload(trial, tighterBudget);
    if (compactJsonLength(trial) > MAX_NANO_BANANA_PROMPT_CHARS - RESERVED_FOR_FINAL_META) {
      const minimized = shrinkEmergencyUntilFits(trial);
      const minimizedCompact = JSON.stringify(minimized);
      if (
        escapedStringLength(minimizedCompact) <= MAX_NANO_BANANA_PROMPT_CHARS &&
        doubleEscapedStringLength(minimizedCompact) <= MAX_NANO_BANANA_PROMPT_CHARS
      ) {
        return minimizedCompact;
      }
      out = minimizedCompact;
      continue;
    }
    const trialCompact = JSON.stringify(trial);
    if (
      escapedStringLength(trialCompact) <= MAX_NANO_BANANA_PROMPT_CHARS &&
      doubleEscapedStringLength(trialCompact) <= MAX_NANO_BANANA_PROMPT_CHARS
    ) {
      return trialCompact;
    }
    out = trialCompact;
  }

  // Последний fallback: возвращаем уже максимально ужатый compact.
  return out;
}

/**
 * Детальный JSON для генераторов изображений (в т.ч. NanoBanana): камера 1:1 с вьюпортом,
 * освещение/трава как в Gravio, архитектурные данные + блок NanoBananaSceneReconstruction.
 */
export function buildNanoBananaPromptJson(input: BuildNanoBananaPromptInput): string {
  const promptProfile = input.promptProfile ?? "parcel";
  const isMasterplanMode = promptProfile === "masterplan";
  const sanitizedParcelContext = input.parcelContext
    ? { ...input.parcelContext, cadNum: null }
    : undefined;
  const masterplanLinearPatternDetected =
    isMasterplanMode &&
    detectMasterplanLinearPattern(
      input.placedModels.map((m) => ({ x: m.placement.x, z: m.placement.z })),
    );
  const isParcelOnlyMode = Boolean(sanitizedParcelContext) && input.architecturalModels.length === 0;
  const parcelRenderNote = buildParcelRenderNote(sanitizedParcelContext);
  const parcelSetting = sanitizedParcelContext
    ? "Parcel-centric pseudo-3D / isometric masterplan composition with a clearly highlighted land plot and restrained landscape details."
    : null;
  const spec = VIEWPORT_OUTDOOR_SPEC;
  const env = {
    ...spec,
    narrative: {
      setting: [
        isMasterplanMode
          ? "Masterplan visualization mode: preserve exact camera and object placements; identical source objects must keep identical geometry while naturally reflecting viewpoint perspective."
          : null,
        parcelSetting,
        "Outdoor architectural visualization, bright natural daylight, soft sky haze, lush short grass lawn, subtle green perspective grid barely visible on the ground, calm park-like atmosphere.",
      ]
        .filter(Boolean)
        .join(" "),
      quality:
        "Photorealistic CGI, physically plausible lighting, soft shadows, high detail materials on buildings, crisp edges, no cartoon look, no people unless specified.",
    },
  };

  const cameraBlock =
    input.camera && !input.error
      ? {
          matchViewportExactly: true,
          coordinateSystem: "Y-up, right-handed (Three.js / glTF style)",
          projection: "perspective",
          position: input.camera.position.map(round6) as [number, number, number],
          lookAtTarget: input.camera.target.map(round6) as [number, number, number],
          up: input.camera.up.map(round6) as [number, number, number],
          quaternion: input.camera.quaternion.map(round6) as [number, number, number, number],
          fovVerticalDeg: round6(input.camera.fovDeg),
          aspect: round6(input.camera.aspect),
          near: round6(input.camera.near),
          far: round6(input.camera.far),
          zoom: round6(input.camera.zoom),
          canvasPixelSize: {
            widthCssPx: Math.round(input.canvasCssWidth),
            heightCssPx: Math.round(input.canvasCssHeight),
          },
          orbitControlsEquivalent: {
            summary: "OrbitControls-equivalent camera state.",
          },
        }
      : {
          error: input.error ?? "Camera not ready — open the scene and wait for the view to load.",
        };

  const prototypeByKey = new Map<string, string>();
  const prototypeList: Array<{ pid: string; size: [number, number, number] }> = [];
  const compactObjects = input.placedModels.map((m, idx) => {
    const detail = input.architecturalModels.find((a) => a.id === m.id);
    const size = detail
      ? [
          round6(detail.localRootBounds.size.width),
          round6(detail.localRootBounds.size.height),
          round6(detail.localRootBounds.size.depth),
        ]
      : [0, 0, 0];
    const key = size.join("|");
    let pid = prototypeByKey.get(key);
    if (!pid) {
      pid = `p${prototypeList.length + 1}`;
      prototypeByKey.set(key, pid);
      prototypeList.push({ pid, size: size as [number, number, number] });
    }
    return {
      oid: `o${idx + 1}`,
      pid,
      t: [
        round6(m.placement.x),
        round6(m.placement.y),
        round6(m.placement.z),
      ] as [number, number, number],
      rY: round6(m.placement.rotationYDeg),
    };
  });

  const generation = {
    intent: "nanoBanana_image_generation",
    instructionsRu: [
      "Сгенерируй одно фотореалистичное изображение.",
      ...(isMasterplanMode
        ? [
            "Режим «Генплан»: строго сохраняй позиции/повороты объектов, камеру и рельеф.",
            "Одинаковые типовые объекты: идентичная геометрия и пропорции; отличия только из-за ракурса.",
            "Пустые зоны между объектами заполняй реалистичным антуражем по месту.",
            "При линейной расстановке добавляй вдоль линии дорогу: проезжая часть, тротуар, бордюр, освещение, базовая разметка, деревья.",
          ]
        : []),
      ...(parcelRenderNote
        ? [
            "Для участка: аккуратно выдели границу, соблюдай масштаб 1:1 и реалистичный рельеф без выдумок.",
            "Растительность только фоновая и ненавязчивая, без перекрытия ключевой геометрии.",
            parcelRenderNote,
          ]
        : []),
      "Камера/кадр/перспектива: строго как в camera.",
      "Окружение и свет: реалистичный дневной экстерьер.",
      ...(compactObjects.length > 0
        ? ["Объекты: соблюдай габариты, высоты и характер объектов по данным сцены."]
        : []),
      "Следуй strict_requirements и narrative_guide. Без изменения фактической структуры сцены.",
      ...(compactObjects.length > 0 ? ["Не упрощай модели до примитивов."] : []),
      "Не добавляй логотипы и водяные знаки.",
    ],
  };
  const objective = isMasterplanMode
    ? "Сгенерировать точный генплан: позиции объектов/камеры/рельефа фиксированы; повторяющиеся типы объектов геометрически идентичны."
    : isParcelOnlyMode
      ? "Сгенерировать точную визуализацию участка: границы, рельеф, масштаб 1:1 и реалистичный контекст без выдумок."
      : "Сгенерировать изображение, точно повторяющее текущую сцену по объектам, камере и рельефу.";
  const strictRequirements = [
    "Не менять позиции объектов, их ориентацию и масштаб относительно исходной сцены.",
    "Не менять параметры камеры и композицию кадра.",
    "Соблюдать масштаб 1:1 и реалистичный рельеф без выдуманных форм.",
    "Не добавлять несуществующие крупные объекты.",
    ...(isMasterplanMode
      ? [
          "Одинаковые типы объектов должны иметь идентичную геометрию.",
          "При линейной расстановке объектов формировать вдоль линии улично-дорожный коридор с базовой инфраструктурой.",
        ]
      : []),
  ];
  const narrativeGuideRu = [
    "Стиль: реалистичная архитектурная визуализация.",
    "Фокус: точная геометрия/позиции объектов, рельеф и камера.",
    "Контекст: естественный дневной свет и правдоподобный антураж без фантазийных элементов.",
  ].join("\n");

  const payload = {
    prompt_type: "NanoBananaSceneReconstruction",
    version: 1,
    objective,
    strict_requirements: strictRequirements,
    narrative_guide: { ru: narrativeGuideRu },
    source_scene: {
      mode: promptProfile,
      objectCount: compactObjects.length,
      prototypeCount: prototypeList.length,
      linearPatternDetected: masterplanLinearPatternDetected,
    },
    camera: cameraBlock,
    render_style: {
      mode: "architectural visualization",
      keep_scene_scale: true,
      gravio_view_mode: input.viewMode,
    },
    meta: {
      generator: "NanoBanana",
      sourceApp: "Gravio",
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      viewMode: input.viewMode,
      promptProfile,
      masterplanLinearPatternDetected,
    },
    gravio: {
      environment: env,
      camera_detail: cameraBlock,
      scene: {
        units: "meters",
        objectPrototypes: prototypeList,
        objects: compactObjects,
        parcelContext: sanitizedParcelContext ?? null,
      },
      generation,
    },
  };

  return finalizeNanoBananaPromptString(payload as Record<string, unknown>);
}

export function collectPlacedModelSnapshots(
  models: IfcModelItem[],
  options?: {
    activeModelId: string | null;
    draftPlacement: IfcModelItem["placement"] | null;
  },
): PlacedModelSnapshot[] {
  return models
    .filter((m) => m.isPlaced)
    .map((m) => {
      const p =
        options?.activeModelId === m.id && options.draftPlacement
          ? options.draftPlacement
          : m.placement;
      return {
        id: m.id,
        name: m.name,
        placement: {
          x: round6(p.x),
          y: round6(p.y),
          z: round6(p.z),
          rotationYRad: round6(p.rotationY),
          rotationYDeg: round6((p.rotationY * 180) / Math.PI),
        },
      };
    });
}
