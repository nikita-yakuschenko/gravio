import type { ArchitecturalModelDetail } from "@/lib/nanoBananaArchitecturalDetail";
import type { BuildNanoBananaPromptInput } from "@/lib/nanoBananaTypes";

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function quatFromYRotation(rad: number): { x: number; y: number; z: number; w: number } {
  const h = rad * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

function vec3FromTuple(t: [number, number, number]): { x: number; y: number; z: number } {
  return { x: round4(t[0]), y: round4(t[1]), z: round4(t[2]) };
}

function quatFromTuple(q: [number, number, number, number]): { x: number; y: number; z: number; w: number } {
  return { x: round4(q[0]), y: round4(q[1]), z: round4(q[2]), w: round4(q[3]) };
}

/**
 * Обёртка в стиле NanoBananaSceneReconstruction + нарративы RU/EN (ультрареализм, живой участок).
 */
export function buildNanoBananaSceneReconstructionBlock(
  input: BuildNanoBananaPromptInput,
): Record<string, unknown> {
  const promptProfile = input.promptProfile ?? "parcel";
  const isMasterplanMode = promptProfile === "masterplan";
  const promptParcelContext = input.parcelContext
    ? { ...input.parcelContext, cadNum: null }
    : undefined;
  const cameraSimple =
    input.camera && !input.error
      ? {
          projection: "perspective",
          position: vec3FromTuple(input.camera.position),
          quaternion: quatFromTuple(input.camera.quaternion),
          target: vec3FromTuple(input.camera.target),
          fov: round4(input.camera.fovDeg),
          near: round4(input.camera.near),
          far: round4(input.camera.far),
          up: vec3FromTuple(input.camera.up),
          aspect: round4(input.camera.aspect),
        }
      : {
          error: input.error ?? "Camera not available",
        };

  const isParcelOnlyMode = Boolean(promptParcelContext) && input.architecturalModels.length === 0;
  if (isParcelOnlyMode) {
    const parcel = promptParcelContext;
    return {
      prompt_type: "NanoBananaSceneReconstruction",
      version: 1,
      objective:
        "Сгенерировать изображение участка по данным Gravio в режиме parcel-only: выразительный, но реалистичный рельеф, читаемая геометрия границ и корректный метрический масштаб без выдуманных объектов.",
      strict_requirements: [
        "Соблюдать масштаб 1:1 в метрах: без произвольного рескейла сцены и без преувеличения вертикального рельефа.",
        "Не добавлять здания, дороги, водоёмы и иные крупные объекты, которых нет в исходных данных сцены.",
        "Не менять ориентацию камеры, перспективу и кадр относительно блока camera.",
        "Сохранять геометрию и масштаб участка без домысливаний.",
      ],
      creative_enhancement: {
        goal: "Сделать участок визуально приятным и читаемым, не нарушая исходные геоданные.",
        living_context_ru:
          "Допустимы только мягкие фоновые элементы: газон, редкие кусты/деревья и натуральные покрытия в свободных зонах.",
        living_context_en:
          "Allow only restrained contextual landscaping: lawn, sparse shrubs/trees, and natural surface variation in open areas.",
        allowed_additions_ru: [
          "Ненавязчивое озеленение без перекрытия границ участка.",
          "Лёгкая фактурность грунта и травы.",
        ],
        allowed_additions_en: [
          "Subtle landscaping that does not obscure parcel boundary readability.",
          "Mild ground/grass texture variation.",
        ],
        forbidden_ru: [
          "Не добавлять дома, хозпостройки, дороги, парковки, заборы и прочие крупные конструкции.",
          "Не менять фактическую форму участка и соотношение горизонтального/вертикального масштаба.",
        ],
        forbidden_en: [
          "Do not add buildings, roads, parking areas, fences, or other major structures.",
          "Do not alter parcel shape or horizontal/vertical scale ratio.",
        ],
      },
      narrative_guide: {
        ru: [
          "Стиль: реалистичная визуализация участка, псевдо-3D/изометрический генплан.",
          "Акцент: границы участка, без архитектурных доминант.",
          "Цвет: натуральная палитра земли/травы, аккуратная подсветка контура участка.",
          `Площадь: ${typeof parcel?.specifiedAreaM2 === "number" ? `${Math.round(parcel.specifiedAreaM2)} м²` : "нет данных"}.`,
        ].join("\n"),
      },
      source_scene: {
        mode: "parcel-only",
        parcel: parcel ?? null,
      },
      camera: cameraSimple,
      render_style: {
        mode: "parcel visualization",
        keep_original_material_balance: true,
        keep_scene_scale: true,
        genre: "Realistic cadastral parcel visualization with restrained landscape context",
        gravio_view_mode: input.viewMode,
      },
    };
  }

  const primary = input.architecturalModels[0];
  const extras = input.architecturalModels.slice(1);
  const firstName = primary?.name ?? input.placedModels[0]?.name ?? "IFC model";

  const houseBbox = primary
    ? {
        min: primary.localRootBounds.min,
        max: primary.localRootBounds.max,
        center: {
          x: round4((primary.localRootBounds.min.x + primary.localRootBounds.max.x) * 0.5),
          y: round4((primary.localRootBounds.min.y + primary.localRootBounds.max.y) * 0.5),
          z: round4((primary.localRootBounds.min.z + primary.localRootBounds.max.z) * 0.5),
        },
        size: {
          x: primary.localRootBounds.size.width,
          y: primary.localRootBounds.size.height,
          z: primary.localRootBounds.size.depth,
        },
      }
    : null;

  const yRad = primary ? primary.placement.rotationYRad : 0;
  const qHouse = quatFromYRotation(yRad);

  const sourceScene = {
    model_name: firstName,
    site_base: {
      origin: { lat: null as number | null, lng: null as number | null },
      contourLocal: null as unknown,
      rotationDeg: primary?.placement.rotationYDeg ?? 0,
      placementZonesLocal: [] as unknown[],
    },
    site_ifc_bbox: null,
    house_ifc_bbox: houseBbox,
    house_transform: primary
      ? {
          position: { x: primary.placement.x, y: primary.placement.y, z: primary.placement.z },
          rotationDeg: { x: 0, y: primary.placement.rotationYDeg, z: 0 },
          quaternion: qHouse,
        }
      : null,
    extra_ifc: extras.map((m) => ({
      id: m.id,
      name: m.name,
      placement: m.placement,
      local_bounds_size: m.localRootBounds.size,
      footprint_area_sq_m: m.world.footprintAreaApproxSqM,
    })),
  };

  const creativeEnhancement = {
    goal:
      "Сохранить геометрию дома и ракурс камеры 1:1, но визуально обогатить сцену правдоподобным обжитым участком как у реального загородного/городского дома.",
    living_context_ru:
      "Добавь живой антураж: умеренно редкие и группы деревьев (лиственные и хвойные, типичные для умеренного климата), кустарник по периметру участка, естественный газон с лёгкой неровностью, мелкие неровности грунта; без фантастики и без инородных объектов.",
    living_context_en:
      "Add believable lived-in plot context: scattered and small groups of temperate-climate deciduous and conifer trees, perimeter shrubs, natural lawn with subtle uneven ground; photoreal, no fantasy elements.",
    allowed_additions_ru: [
      "Деревья и кусты на безопасном отступе от стен, не перекрывающие габарит дома из данных IFC.",
      "Мелкие садовые детали (клумбы, дорожки из плитки/мульчи) только в свободных зонах между следом дома и условной границей участка.",
      "Лёгкая атмосферная дымка и естественное дневное солнце, согласованное с направлением света в render_style.",
    ],
    allowed_additions_en: [
      "Trees/shrubs set back from walls; must not change the house footprint from IFC data.",
      "Small paths/mulch beds only in open areas, not under the building footprint.",
      "Soft atmospheric haze and natural daylight consistent with scene lighting.",
    ],
    forbidden_ru: [
      "Не добавлять посторонние здания, улицы, соседские дома, автомобильные трассы.",
      "Не менять форму, размер и положение дома, фундамент и кровлю относительно участка.",
      "Не менять камеру, перспективу и кадр относительно блока camera.",
      "Не добавлять людей и животных в кадр (по умолчанию).",
    ],
    forbidden_en: [
      "No extra buildings, roads, or neighbor houses.",
      "Do not alter house geometry, footprint, or placement vs. site data.",
      "Do not change camera framing vs. the camera block.",
      "No people or animals in frame unless explicitly requested.",
    ],
  };

  const narrativeGuideRu = [
    "Стиль и жанр:",
    "Ультра-реализм, кинематографичный фотореализм, гиперреалистичная фотография, архитектурная визуализация.",
    "",
    "Основной объект:",
    "Дом(а) по IFC: точная геометрия и положение относительно участка, без изменения ориентации и пропорций.",
    "",
    "Живой антураж (без ломки геометрии):",
    "Участок как у реального дома: деревья, кустарник, естественный грунт и газон, правдоподобная растительность зоны; без чужих построек.",
    "",
    "Поза и движение:",
    "Статичная сцена, фиксированный ракурс камеры, без динамики.",
    "",
    "Детали объекта:",
    "Фасад и кладка с сохранением масштаба текстур; окна и двери по данным IFC; крыша и вход как в сцене.",
    "",
    "Фон и окружение:",
    "Границы участка не раздвигать произвольно; растительность и забор/изгородь — только если уместны и не перекрывают дом.",
    "",
    "Освещение:",
    "Естественный дневной свет, мягкие тени, направление света согласовано с описанием сцены Gravio.",
    "",
    "Цветовая палитра:",
    "Естественные цвета фасада и земли, нейтральные серый, белый, коричневый, зелень растений.",
    "",
    "Ракурс и план:",
    "Сохранить композицию кадра из камеры; средний/дальний план — как в текущем виде.",
    "",
    "Камера:",
    "Позиция, кватернион, target и FOV — строго по полю camera.",
    "",
    "Качество изображения:",
    "4K-class detail, HDR-ощущение, детальные материалы, точный масштаб.",
  ].join("\n");

  return {
    prompt_type: "NanoBananaSceneReconstruction",
    version: 1,
    objective: isMasterplanMode
      ? "Сгенерировать генплан-сцену с высокой точностью: фиксированные позиции объектов/камеры/рельефа, идентичная геометрия повторяющихся типов и реалистичное заполнение межобъектного пространства городской/поселковой инфраструктурой."
      : "Сгенерировать изображение, максимально точно повторяющее текущую сцену Gravio: те же IFC-объекты (геометрия и размещение), то же окружение по смыслу и тот же ракурс камеры; допускается обогащение участка живой растительностью в рамках creative_enhancement.",
    strict_requirements: [
      "Не менять геометрию, пропорции и положение зданий относительно следа на земле из данных scene.",
      "Не менять ориентацию камеры, перспективу и кадр относительно блока camera.",
      "Соблюдать масштаб 1:1 в метрах: без произвольного рескейла сцены, без сжатия/растяжения и без преувеличения вертикального рельефа.",
      "Не добавлять посторонние здания, дороги и элементы, противоречащие сцене.",
      "Сохранить компоновку кадра; направление «света/севера» согласовать с описанием освещения Gravio.",
      ...(isMasterplanMode
        ? [
            "Для одинаковых типовых объектов сохранять одинаковую геометрию и пропорции; допускается только визуальная разница из-за перспективы/ракурса.",
            "В незаполненных зонах между объектами добавлять только правдоподобный контекст окружения по месту, без фантазийных объектов.",
            "При линейном размещении объектов формировать вдоль линии улично-дорожный профиль: дорога, тротуары, бордюры, освещение, базовая разметка и уместное озеленение.",
          ]
        : []),
    ],
    creative_enhancement: creativeEnhancement,
    narrative_guide: {
      ru: narrativeGuideRu,
    },
    source_scene: sourceScene,
    camera: cameraSimple,
    render_style: {
      mode: "architectural visualization",
      keep_original_material_balance: true,
      keep_scene_scale: true,
      genre:
        "Ultra-realism, cinematic photorealism, hyperrealistic photography, real outdoor residential conditions",
      gravio_view_mode: input.viewMode,
    },
  };
}
