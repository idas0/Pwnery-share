import { CatalogItem } from '../shared/types.js';
import { Supplier } from '../ordering/ports.js';
import logger from '../../shared/logger.js';

const ADVERTISED_STOCK_FRACTION = 0.8;
const log = logger.child({ domain: 'inventory.sync' });
const flow = 'inventory_suppliers';

export async function fetchAllSupplierStock(
  suppliers: Supplier[],
  activeSkus: Set<string>,
): Promise<CatalogItem[]> {
  const results = await Promise.allSettled(
    suppliers.map(async (supplier) => ({
      supplierId: supplier.supplierId,
      items: await supplier.fetchStock(activeSkus),
    })),
  );

  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<{ supplierId: string; items: CatalogItem[] }> => result.status === 'fulfilled',
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.error({
        flow,
        event: 'supplier_fetch_failed',
        err: result.reason,
        supplierId: suppliers[index]?.supplierId,
      }, 'event=supplier_fetch_failed supplier stock fetch failed');
    }
  });

  if (fulfilled.length === 0) {
    throw new Error('fetchAllSupplierStock: all supplier stock fetches failed');
  }

  return fulfilled
    .flatMap((result) => result.value.items)
    .map((item) => ({
      ...item,
      stock: Math.floor(item.stock * ADVERTISED_STOCK_FRACTION),
    }))
    .filter((item) => item.stock > 0);
}

export function diffStock(
  cheapest: CatalogItem[],
  stored: CatalogItem[],
): CatalogItem[] {
  const dirtyItems: CatalogItem[] = [];
  const fetchedMap = new Map<string, CatalogItem>(cheapest.map(i => [i.sku, i]));
  const storedMap  = new Map<string, CatalogItem>(stored.map(i => [i.sku, i]));

  for (const item of cheapest) {
    const existing = storedMap.get(item.sku);
    const unchanged = existing
      && existing.stock      === item.stock
      && existing.cost       === item.cost
      && existing.supplierId === item.supplierId;

    if (!unchanged) {
      dirtyItems.push(item);
    }
  }

  for (const storedItem of stored) {
    if (!fetchedMap.has(storedItem.sku) && storedItem.stock !== 0) {
      dirtyItems.push({ ...storedItem, stock: 0 });
    }
  }

  return dirtyItems;
}
