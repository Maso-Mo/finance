import { analyticsOverviewResponseSchema, dashboardResponseSchema, financialForecastResponseSchema, monthlyBudgetsResponseSchema } from '@finance/shared-types';

const schemas = { analytics: analyticsOverviewResponseSchema, dashboard: dashboardResponseSchema, forecast: financialForecastResponseSchema, budgets: monthlyBudgetsResponseSchema };
export type SnapshotKind = keyof typeof schemas;
export interface Snapshot<T = unknown> { userId: string; kind: SnapshotKind; syncedAt: string; data: T }
const DB_NAME = 'finance-read-snapshots-v1';
let identity: string | null = null;
let generation = 0;
export function setSnapshotIdentity(userId: string | null) { identity = userId; generation++; }
export function snapshotIdentity() { return identity; }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: ['userId', 'kind'] });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveSnapshot(kind: SnapshotKind, data: unknown, expectedUserId: string | null = identity): Promise<void> {
  const userId = identity, version = generation;
  if (!userId || userId !== expectedUserId) return;
  // Zod explicitly strips unknown properties at each supported response boundary.
  const parsed = schemas[kind].parse(data);
  const snapshot: Snapshot = { userId, kind, syncedAt: new Date().toISOString(), data: parsed };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 128_000) return;
  const db = await database();
  if (identity !== userId || version !== generation) { db.close(); return; }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put(snapshot);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}
export async function loadSnapshot<T>(kind: SnapshotKind): Promise<Snapshot<T> | null> {
  const userId = identity, version = generation;
  if (!userId) return null;
  const db = await database();
  return new Promise<Snapshot<T> | null>((resolve, reject) => {
    const request = db.transaction('snapshots').objectStore('snapshots').get([userId, kind]);
    request.onsuccess = () => {
      const row = request.result as Snapshot | undefined;
      const parsed = schemas[kind].safeParse(row?.data);
      resolve(identity === userId && generation === version && row?.userId === userId && parsed.success ? { ...row, data: parsed.data as T } : null);
    };
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}
export async function clearSnapshots(userId: string): Promise<void> {
  // Invalidates pending reads/writes before opening the cleanup transaction.
  if (identity === userId) setSnapshotIdentity(null);
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readwrite'); const store = tx.objectStore('snapshots');
    for (const kind of Object.keys(schemas)) store.delete([userId, kind]);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }).finally(() => db.close());
}
