import * as fs from 'fs/promises';
import * as path from 'path';
import { CatalogItem } from '../../domains/shared/types.js';
import { DeltaFile } from '../../domains/inventory/delta.js';
import {
  HubCycleMeta,
  HubStateStore,
} from '../../domains/inventory/ports.js';

export class FileStockStateStore implements HubStateStore {
  private readonly stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir
      ? path.resolve(stateDir)
      : path.resolve(process.env.STATE_DIR ?? '.runtime-state');
  }

  getDeltaPath(): string {
    return this.hubDeltaPath();
  }

  async readPreviousSnapshot(): Promise<CatalogItem[]> {
    await ensureDir(this.stateDir);
    return readJsonFile<CatalogItem[]>(this.hubPreviousSnapshotPath(), []);
  }

  async writePreviousSnapshot(rows: CatalogItem[]): Promise<void> {
    await writeJsonAtomic(this.hubPreviousSnapshotPath(), rows);
  }

  async writeDelta(delta: DeltaFile): Promise<void> {
    await writeJsonAtomic(this.hubDeltaPath(), delta);
  }

  async writeFullStock(rows: CatalogItem[]): Promise<void> {
    await writeJsonAtomic(this.fullStockPath(), rows);
  }

  async writeCycleMeta(meta: HubCycleMeta): Promise<void> {
    await writeJsonAtomic(this.hubCycleMetaPath(), meta);
  }

  async readDelta(): Promise<DeltaFile> {
    await ensureDir(this.stateDir);
    return readJsonFile<DeltaFile>(this.hubDeltaPath(), {
      snapshotId: `${Date.now()}`,
      rows: [],
    });
  }

  private hubPreviousSnapshotPath(): string {
    return path.join(this.stateDir, 'hub-previous-raw.json');
  }

  private hubDeltaPath(): string {
    return path.join(this.stateDir, 'hub-delta.json');
  }

  private fullStockPath(): string {
    return path.join(this.stateDir, 'full-stock.json');
  }

  private hubCycleMetaPath(): string {
    return path.join(this.stateDir, 'hub-cycle-meta.json');
  }

}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return fallback;
    }
    throw err;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data), 'utf-8');
  await fs.rename(tmpPath, filePath);
}
