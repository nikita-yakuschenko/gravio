import type { IfcAnalysis, IfcPlacement } from "@/types/ifc";

const DB_NAME = "gravio_ifc_db";
const DB_VERSION = 1;
const STORE_MODELS = "ifc_models";

export interface PersistedIfcModelRecord {
  id: string;
  name: string;
  size: number;
  addedAt: number;
  lastModified: number;
  fileBlob: Blob;
  analysis?: IfcAnalysis;
  placement?: IfcPlacement;
  isPlaced?: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function ensureBrowser(): void {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is only available in browser runtime.");
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

async function openDb(): Promise<IDBDatabase> {
  ensureBrowser();
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_MODELS)) {
          db.createObjectStore(STORE_MODELS, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Cannot open IndexedDB."));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  const db = dbPromise;
  if (!db) throw new Error("IndexedDB initialization failed.");
  return db;
}

export async function getAllIfcRecords(): Promise<PersistedIfcModelRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_MODELS, "readonly");
  const store = tx.objectStore(STORE_MODELS);
  const request = store.getAll();
  const rows = await requestToPromise<PersistedIfcModelRecord[]>(request);
  await transactionDone(tx);
  return rows;
}

export async function upsertIfcRecord(record: PersistedIfcModelRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_MODELS, "readwrite");
  tx.objectStore(STORE_MODELS).put(record);
  await transactionDone(tx);
}

export async function deleteIfcRecord(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_MODELS, "readwrite");
  tx.objectStore(STORE_MODELS).delete(id);
  await transactionDone(tx);
}

export async function clearIfcRecords(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_MODELS, "readwrite");
  tx.objectStore(STORE_MODELS).clear();
  await transactionDone(tx);
}
