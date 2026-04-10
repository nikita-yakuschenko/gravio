import type { IfcModelItem } from "@/types/ifc";
import { VIEWPORT_OUTDOOR_SPEC } from "@/lib/viewportOutdoorSpec";
import { buildNanoBananaSceneReconstructionBlock } from "@/lib/nanoBananaSceneReconstruction";
import type {
  BuildNanoBananaPromptInput,
  NanoBananaCameraSnapshot,
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

const TRUNC_SUFFIX = "…[усечено по лимиту]";

function truncatePromptText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const n = Math.max(0, maxChars - TRUNC_SUFFIX.length);
  return (n > 0 ? s.slice(0, n) : "") + TRUNC_SUFFIX;
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
  if (pretty.length <= MAX_NANO_BANANA_PROMPT_CHARS) return pretty;
  return compact;
}

/**
 * Детальный JSON для генераторов изображений (в т.ч. NanoBanana): камера 1:1 с вьюпортом,
 * освещение/трава как в Gravio, архитектурные данные + блок NanoBananaSceneReconstruction.
 */
export function buildNanoBananaPromptJson(input: BuildNanoBananaPromptInput): string {
  const spec = VIEWPORT_OUTDOOR_SPEC;
  const env = {
    ...spec,
    narrative: {
      setting:
        "Outdoor architectural visualization, bright natural daylight, soft sky haze, lush short grass lawn, subtle green perspective grid barely visible on the ground, calm park-like atmosphere.",
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
            note: "Same as OrbitControls target + perspective camera position in Three.js.",
          },
        }
      : {
          error: input.error ?? "Camera not ready — open the scene and wait for the view to load.",
        };

  const reconstruction = {
    summaryRu:
      input.architecturalModels.length > 0
        ? input.architecturalModels.map((m) => m.reconstructionPromptRu).join("\n\n")
        : "Нет размещённых моделей с полными метаданными.",
    summaryEn:
      input.architecturalModels.length > 0
        ? input.architecturalModels.map((m) => m.reconstructionPromptEn).join("\n\n")
        : "No placed models with full metadata.",
    perModelPrompts: input.architecturalModels.map((m) => ({
      id: m.id,
      ru: m.reconstructionPromptRu,
      en: m.reconstructionPromptEn,
    })),
  };

  const generation = {
    intent: "nanoBanana_image_generation",
    instructionsRu: [
      "Сгенерируй одно изображение: фотореалистичный рендер архитектурной сцены.",
      "Камера, кадр и перспектива должны совпадать с блоком camera / nanoBananaSceneReconstruction.camera — без сдвига и без другого угла.",
      "Окружение: живое наружное освещение днём, лёгкая дымка на горизонте, трава на земле, небо светло-голубое, как в environment.",
      "Архитектура: для каждого объекта в scene.architecturalModels используй численные габариты, след на земле, высоту, данные IFC (стены/окна/двери) и поля reconstructionPromptRu/en — здания должны быть визуально неотличимы по масштабу, пропорциям и характеру от эталона.",
      "Секция nanoBananaSceneReconstruction: следуй objective, strict_requirements, narrative_guide и creative_enhancement — допускается живой антураж (деревья, участок), но без изменения дома и камеры.",
      "Не упрощай модели до коробок: сохраняй сложность, соответствующую числу треугольников в geometryMesh.",
      "Не добавляй логотипы и водяные знаки.",
    ],
    instructionsEn: [
      "Generate one photorealistic architectural render.",
      "Match the camera blocks exactly (gravio viewport + nanoBananaSceneReconstruction.camera) — identical framing.",
      "Environment: outdoor daylight, soft atmospheric haze, grass ground, pale blue sky as in environment.",
      "Architecture: follow scene.architecturalModels numeric data and reconstruction prompts.",
      "Use nanoBananaSceneReconstruction (objective, strict_requirements, narrative_guide, creative_enhancement) for lived-in plot enrichment (trees, plants) without altering buildings or camera.",
      "Do not reduce buildings to primitive boxes; preserve detail consistent with triangle counts in geometryMesh.",
      "No logos or watermarks.",
    ],
  };

  const nanoBananaSceneReconstruction = buildNanoBananaSceneReconstructionBlock(input);

  const payload = {
    ...nanoBananaSceneReconstruction,
    meta: {
      generator: "NanoBanana",
      sourceApp: "Gravio",
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      viewMode: input.viewMode,
      note: "Корневые поля prompt_type … render_style — шаблон сцены; блок gravio — детали вьюпорта.",
    },
    gravio: {
      environment: env,
      camera_detail: cameraBlock,
      scene: {
        units: "meters",
        placedModels: input.placedModels,
        architecturalModels: input.architecturalModels,
        reconstruction,
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
