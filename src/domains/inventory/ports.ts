import { CatalogItem } from '../shared/types.js';
import { DeltaFile } from './delta.js';

export interface InventoryRepository {
  getAll(): Promise<CatalogItem[]>;
  getBySku(sku: string): Promise<CatalogItem | null>;
  getBatchBySku(skus: string[]): Promise<CatalogItem[]>;
  getSnapshotId(): Promise<string | null>;
  setSnapshotId(snapshotId: string): Promise<void>;
  saveAll(items: CatalogItem[]): Promise<void>;
}

export interface HubCycleMeta {
  snapshotId: string;
  generatedAt: string;
  durationMs: number;
  supplierRows: number;
  dirtySkus: number;
  deltaRows: number;
}

export interface HubStateStore {
  getDeltaPath(): string;
  readDelta(): Promise<DeltaFile>;
  readPreviousSnapshot(): Promise<CatalogItem[]>;
  writePreviousSnapshot(rows: CatalogItem[]): Promise<void>;
  writeDelta(delta: DeltaFile): Promise<void>;
  writeFullStock(rows: CatalogItem[]): Promise<void>;
  writeCycleMeta(meta: HubCycleMeta): Promise<void>;
}

