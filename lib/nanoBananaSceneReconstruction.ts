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
  const primary = input.architecturalModels[0];
  const extras = input.architecturalModels.slice(1);
  const firstName = primary?.name ?? input.placedModels[0]?.name ?? "IFC model";

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
      origin_note:
        "В Gravio координаты участка WGS84 не задаются — при наличии данных укажите lat/lng вручную для генератора.",
      contourLocal: null as unknown,
      contour_note: "Полигон границ участка из внешней CAD/GIS в текущем экспорте отсутствует.",
      rotationDeg: primary?.placement.rotationYDeg ?? 0,
      placementZonesLocal: [] as unknown[],
      placementZones_note:
        "Зоны house/bathhouse/garage и т.п. из внешних систем не хранятся в Gravio — массив пустой, можно дополнить вручную.",
    },
    site_ifc_bbox: null,
    site_ifc_bbox_note: "Общий bbox участка IFC в приложении не экспортируется.",
    house_ifc_bbox: houseBbox,
    house_transform: primary
      ? {
          position: { x: primary.placement.x, y: primary.placement.y, z: primary.placement.z },
          rotationDeg: { x: 0, y: primary.placement.rotationYDeg, z: 0 },
          quaternion: qHouse,
          note: "Позиция и поворот — в метрах, мир Gravio (Y-up), вокруг Y только rotationY из размещения.",
        }
      : null,
    extra_ifc: extras.map((m) => ({
      id: m.id,
      name: m.name,
      placement: m.placement,
      local_bounds_size: m.localRootBounds.size,
      footprint_area_sq_m: m.world.footprintAreaApproxSqM,
    })),
    extra_ifc_note: "Остальные размещённые IFC-модели на сцене (порядок не важен для кадра).",
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

  const narrativeGuideEn = [
    "Style and genre:",
    "Ultra-realism, cinematic photorealism, hyperrealistic photography, architectural visualization.",
    "",
    "Main subject:",
    "House(s) per IFC: exact geometry and placement on the plot; no orientation or proportion changes.",
    "",
    "Living atmosphere (without breaking geometry):",
    "Real residential plot feel: trees, shrubs, natural turf and soil variation, temperate vegetation; no alien structures.",
    "",
    "Pose and movement:",
    "Static scene; fixed camera; no motion blur or dynamic elements.",
    "",
    "Object details:",
    "Facade and masonry at correct texture scale; windows and doors per IFC; roof and entry as in scene.",
    "",
    "Background and environment:",
    "Do not invent neighboring buildings or roads; vegetation and fences only where plausible and not occluding the house.",
    "",
    "Lighting:",
    "Natural daylight, soft shadows; light direction consistent with Gravio scene description.",
    "",
    "Color palette:",
    "Natural facade and ground tones; neutral grays, whites, browns; realistic greens.",
    "",
    "Angle and framing:",
    "Match camera composition from the camera block.",
    "",
    "Camera:",
    "Position, quaternion, target, and FOV — strictly per camera field.",
    "",
    "Image quality:",
    "4K-class detail, HDR-like tonal range, rich materials, accurate scale.",
  ].join("\n");

  return {
    prompt_type: "NanoBananaSceneReconstruction",
    version: 1,
    objective:
      "Сгенерировать изображение, максимально точно повторяющее текущую сцену Gravio: те же IFC-объекты (геометрия и размещение), то же окружение по смыслу и тот же ракурс камеры; допускается обогащение участка живой растительностью в рамках creative_enhancement.",
    strict_requirements: [
      "Не менять геометрию, пропорции и положение зданий относительно следа на земле из данных scene.",
      "Не менять ориентацию камеры, перспективу и кадр относительно блока camera.",
      "Не добавлять посторонние здания, дороги и элементы, противоречащие сцене.",
      "Сохранить компоновку кадра; направление «света/севера» согласовать с описанием освещения Gravio.",
    ],
    creative_enhancement: creativeEnhancement,
    narrative_guide: {
      ru: narrativeGuideRu,
      en: narrativeGuideEn,
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
