/**
 * Константы сцены «светлый день / трава» — общие для IfcViewport и экспорта промпта NanoBanana.
 * При правках OutdoorGroundEnvironment обновляйте и этот файл.
 */
export const VIEWPORT_OUTDOOR_SPEC = {
  backgroundHex: "#c8e2f2",
  fog: { colorHex: "#c8e2f2" as const, near: 50, far: 400 },
  hemisphere: { skyHex: "#d8efff", groundHex: "#2a3d26", intensity: 0.58 },
  ambient: { colorHex: "#f4fbff", intensity: 0.42 },
  directionalWarm: {
    position: [26, 44, 22] as const,
    intensity: 1.22,
    colorHex: "#fff6e8",
  },
  directionalCool: {
    position: [-30, 16, -26] as const,
    intensity: 0.44,
    colorHex: "#a9c9ea",
  },
  ground: {
    grassColorHex: "#4a7f42",
    planeY: -0.003,
    planeSize: 900,
    roughness: 0.93,
    metalness: 0.03,
  },
  grid: {
    size: 260,
    divisions: 52,
    /** Цвета как у GridHelper (числовой 0x…). */
    colorCenter: 0xf6c453,
    colorGrid: 0xd7dee6,
    y: 0.001,
  },
  renderer: {
    toneMapping: "ACESFilmic" as const,
    toneMappingExposure: 1.06,
  },
} as const;
