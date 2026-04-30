import { CatalogItem } from '../shared/types.js';

export interface DeltaRow extends CatalogItem {
  isTombstone?: boolean;
}

export interface DeltaFile {
  snapshotId: string;
  rows: DeltaRow[];
}

export interface SupplierDeltaResult {
  snapshot: CatalogItem[];
  delta: DeltaFile;
  dirtySkus: string[];
}

function rowKey(row: CatalogItem): string {
  return `${row.sku}::${row.supplierId}::${row.supplierSku}`;
}

export function computeSupplierDelta(
  previousSnapshot: CatalogItem[],
  currentSnapshot: CatalogItem[],
  snapshotId: string,
): SupplierDeltaResult {
  const previousByKey = new Map(previousSnapshot.map((row) => [rowKey(row), row]));
  const currentByKey = new Map(currentSnapshot.map((row) => [rowKey(row), row]));

  const dirtySkus = new Set<string>();
  const deltaRows: DeltaRow[] = [];

  for (const row of currentSnapshot) {
    const previous = previousByKey.get(rowKey(row));
    const changed = previous === undefined
      || previous.stock !== row.stock
      || previous.cost !== row.cost;
    if (changed) {
      dirtySkus.add(row.sku);
      deltaRows.push(row);
    }
  }

  for (const previousRow of previousSnapshot) {
    const key = rowKey(previousRow);
    if (currentByKey.has(key)) {
      continue;
    }

    dirtySkus.add(previousRow.sku);
    deltaRows.push({
      sku: previousRow.sku,
      supplierId: previousRow.supplierId,
      supplierSku: previousRow.supplierSku,
      stock: 0,
      cost: 0,
      isTombstone: true,
    });
  }
  deltaRows.sort((a, b) => {
    const skuCmp = a.sku.localeCompare(b.sku);
    if (skuCmp !== 0) return skuCmp;
    const supplierCmp = a.supplierId.localeCompare(b.supplierId);
    if (supplierCmp !== 0) return supplierCmp;
    return a.supplierSku.localeCompare(b.supplierSku);
  });

  return {
    snapshot: currentSnapshot,
    delta: {
      snapshotId,
      rows: deltaRows,
    },
    dirtySkus: Array.from(dirtySkus).sort((a, b) => a.localeCompare(b)),
  };
}
