import type { IfcModelItem } from "@/types/ifc";
import { VIEWPORT_OUTDOOR_SPEC } from "@/lib/viewportOutdoorSpec";
import { buildNanoBananaSceneReconstructionBlock } from "@/lib/nanoBananaSceneReconstruction";
import type {
  BuildNanoBananaPromptInput,
  NanoBananaCameraSnapshot,
  PlacedModelSnapshot,
} from "@/lib/nanoBananaTypes";

export type { BuildNanoBananaPromptInput, NanoBananaCameraSnapshot, PlacedModelSnapshot };

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
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

  return JSON.stringify(payload, null, 2);
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
