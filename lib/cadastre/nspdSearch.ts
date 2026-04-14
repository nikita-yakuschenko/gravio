export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export type GeoJsonFeature = {
  type: "Feature";
  geometry: GeoJsonPolygon | { type: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
};

export type NspdSearchResponse = {
  data?: { type: string; features?: GeoJsonFeature[] };
  meta?: Array<{ totalCount?: number; categoryId?: number }>;
};

export function getFirstLandFeature(json: NspdSearchResponse): GeoJsonFeature | null {
  const features = json.data?.features;
  if (!features?.length) return null;
  const f = features[0];
  if (!f || f.type !== "Feature") return null;
  return f;
}

export function isPolygonGeometry(g: GeoJsonFeature["geometry"]): g is GeoJsonPolygon {
  return g?.type === "Polygon" && Array.isArray((g as GeoJsonPolygon).coordinates?.[0]);
}
