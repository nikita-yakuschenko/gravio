import { IfcAPI, LogLevel } from "web-ifc";

let ifcApiPromise: Promise<IfcAPI> | null = null;

export function getIfcApi(): Promise<IfcAPI> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IFC API is available only in the browser."));
  }

  if (!ifcApiPromise) {
    ifcApiPromise = (async () => {
      const api = new IfcAPI();
      api.SetWasmPath("/web-ifc/", true);
      await api.Init(undefined, true);
      try {
        api.SetLogLevel(LogLevel.LOG_LEVEL_ERROR);
      } catch {
        // Some web-ifc builds may not expose SetLogLevel immediately.
      }
      return api;
    })().catch((error) => {
      ifcApiPromise = null;
      throw error;
    });
  }

  return ifcApiPromise;
}
