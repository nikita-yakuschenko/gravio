import { IFCDOOR, IFCSLAB, IFCSPACE, IFCWALL, IFCWINDOW } from "web-ifc";
import type { IfcAnalysis } from "@/types/ifc";
import { getIfcApi } from "@/lib/ifc/getIfcApi";

function asMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "IFC analysis failed.";
}

export async function analyzeIfcFile(file: File): Promise<IfcAnalysis> {
  const startedAt = performance.now();
  const api = await getIfcApi();
  const bytes = new Uint8Array(await file.arrayBuffer());

  let modelId = -1;

  try {
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
    if (modelId < 0) throw new Error("web-ifc could not open this file.");

    const schema = api.GetModelSchema(modelId) || "UNKNOWN";
    const entityTotal = api.GetAllLines(modelId).size();

    const count = (type: number) => api.GetLineIDsWithType(modelId, type, true).size();

    return {
      schema,
      entityTotal,
      elementMetrics: {
        walls: count(IFCWALL),
        slabs: count(IFCSLAB),
        doors: count(IFCDOOR),
        windows: count(IFCWINDOW),
        spaces: count(IFCSPACE),
      },
      analysisMs: performance.now() - startedAt,
    };
  } catch (error) {
    throw new Error(asMessage(error));
  } finally {
    if (modelId >= 0) api.CloseModel(modelId);
  }
}
