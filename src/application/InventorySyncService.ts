import { fetchAllSupplierStock } from '../domains/inventory/sync.js';
import { computeSupplierDelta, DeltaFile } from '../domains/inventory/delta.js';
import { resolveCheapest } from '../domains/pricing/finalPrice.js';
import { applyNewFloorPrice, SkuPricingState } from '../domains/pricing/pricingState.js';
import { HubStateStore, InventoryRepository } from '../domains/inventory/ports.js';
import { Marketplace as OrderingMarketplace, Supplier, ListingUpdate } from '../domains/ordering/ports.js';
import { PricingStateRepository, ShippingRuleRepository, AttributesRepository, ExchangeRateRepository, MarketplaceConfig } from '../domains/pricing/ports.js';
import { CatalogItem } from '../domains/shared/types.js';
import logger from '../shared/logger.js';

const log = logger.child({ service: 'InventorySyncService' });
const flow = 'inventory_sync';

export class InventorySyncService {
  private spokeRunning = false;
  private spokeQueued = false;

  constructor(
    private readonly suppliers:         Supplier[],
    private readonly inventoryRepo:     InventoryRepository,
    private readonly pricingStateRepo:  PricingStateRepository,
    private readonly shippingRules:     ShippingRuleRepository,
    private readonly attributes:        AttributesRepository,
    private readonly exchangeRates:     ExchangeRateRepository,
    private readonly hubStateStore:     HubStateStore,
    private readonly marketplaceConfig: MarketplaceConfig,
    private readonly marketplace:       OrderingMarketplace,
  ) {}

  async runHub(activeSkus: Set<string>): Promise<void> {
    const snapshotId = `${Date.now()}`;
    const startedAt = Date.now();

    const previousSnapshot = await this.hubStateStore.readPreviousSnapshot();
    const currentSnapshot = await fetchAllSupplierStock(this.suppliers, activeSkus);
    const delta = computeSupplierDelta(previousSnapshot, currentSnapshot, snapshotId);

    await this.hubStateStore.writeFullStock(currentSnapshot);
    await this.hubStateStore.writeDelta(delta.delta);
    await this.hubStateStore.writePreviousSnapshot(delta.snapshot);
    await this.hubStateStore.writeCycleMeta({
      snapshotId,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      supplierRows: currentSnapshot.length,
      dirtySkus: delta.dirtySkus.length,
      deltaRows: delta.delta.rows.length,
    });

    log.info({
      flow,
      event: 'hub_cycle_complete',
      snapshotId,
      supplierRows: currentSnapshot.length,
      dirtySkus: delta.dirtySkus.length,
      deltaRows: delta.delta.rows.length,
      durationMs: Date.now() - startedAt,
    }, 'event=hub_cycle_complete inventory hub cycle complete');
  }

  async startSpokeWatcher(reconcileIntervalMs: number): Promise<void> {
    const chokidar = await import('chokidar');
    const watcher = chokidar.watch(this.hubStateStore.getDeltaPath(), {
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignoreInitial: false,
    });

    const trigger = async () => {
      if (this.spokeRunning) {
        this.spokeQueued = true;
        return;
      }
      this.spokeRunning = true;
      try {
        await this.processSpokeDelta();
      } finally {
        this.spokeRunning = false;
        if (this.spokeQueued) {
          this.spokeQueued = false;
          await trigger();
        }
      }
    };

    watcher.on('add', trigger);
    watcher.on('change', trigger);
    watcher.on('error', (err) => {
      log.error({ flow, event: 'spoke_watcher_error', err }, 'event=spoke_watcher_error inventory spoke watcher error');
    });

    setInterval(() => {
      void trigger();
    }, reconcileIntervalMs).unref();

    await new Promise<void>(() => undefined);
  }

  async runSpokeOnce(): Promise<void> {
    await this.processSpokeDelta();
  }

  private async processSpokeDelta(): Promise<void> {
    const delta = await this.hubStateStore.readDelta();
    const currentSnapshotId = await this.inventoryRepo.getSnapshotId();
    if (currentSnapshotId === delta.snapshotId) return;
    if (delta.rows.length === 0) return;
    const tombstoneItems = delta.rows.filter((row) => row.isTombstone === true);
    const tombstoneSkus = Array.from(new Set(tombstoneItems.map((row) => row.sku)));
    const listingUpdates: ListingUpdate[] = [];
    if (tombstoneSkus.length > 0) {
      listingUpdates.push(...tombstoneSkus.map((sku) => ({ sku, quantity: 0, price: 0 })));
    }
    await this.pricingStateRepo.deleteBatch(tombstoneSkus);

    const updatedItems = delta.rows.filter((row) => row.stock > 0 && row.isTombstone !== true);
    const previousItems = await this.inventoryRepo.getBatchBySku(
      delta.rows.map((row) => row.sku),
    );
    const itemsWithMinimumPrice = await resolveCheapest(
      [...updatedItems, ...previousItems],
      this.shippingRules,
      this.attributes,
      this.exchangeRates,
      this.marketplaceConfig,
    );
  
    const pricingStateUpdates: { sku: string; state: SkuPricingState }[] = [];
    const inventoryBySku = new Map<string, CatalogItem>(
      tombstoneItems.map((item) => [item.sku, item]),
    );
    const previousBySku = new Map(previousItems.map((item) => [item.sku, item]));
    for (const { item: next, minimumPrice } of itemsWithMinimumPrice) {
      const previous = previousBySku.get(next.sku) ?? null;
      const cheapestChanged = !previous
        || next.supplierId !== previous.supplierId
        || next.supplierSku !== previous.supplierSku
        || next.stock !== previous.stock
        || next.cost !== previous.cost;
      if (!cheapestChanged) continue;
      inventoryBySku.set(next.sku, next);
      const pricingState = await this.pricingStateRepo.load(next.sku);
      const result = applyNewFloorPrice(minimumPrice, pricingState, pricingState?.lastOffers ?? []);
      if (result.emergencyPrice !== null) {
        listingUpdates.push({ sku: next.sku, quantity: next.stock, price: result.emergencyPrice });
        pricingStateUpdates.push({ sku: next.sku, state: result.nextState });
      }
    }
    
    await this.marketplace.updateListingsBatch(listingUpdates);
    await this.pricingStateRepo.saveBatch(pricingStateUpdates);
    await this.inventoryRepo.saveAll([...inventoryBySku.values()]);
    await this.inventoryRepo.setSnapshotId(delta.snapshotId);
  }
}
