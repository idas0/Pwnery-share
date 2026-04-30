import 'dotenv/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { BasicFtpService } from '../infrastructure/ftp/BasicFtpService.js';
import { STOCK_FTP_CONFIG } from '../infrastructure/suppliers/sitc/ftpConfig.js';
import { SitcSupplierSource } from '../infrastructure/suppliers/sitc/SitcSupplier.js';
import { DynamoInventoryRepository } from '../infrastructure/dynamo/DynamoInventoryRepository.js';
import { DynamoShippingRuleRepository } from '../infrastructure/dynamo/DynamoShippingRuleRepository.js';
import { DynamoAttributesRepository } from '../infrastructure/dynamo/DynamoAttributesRepository.js';
import { DynamoPricingStateRepository } from '../infrastructure/dynamo/DynamoPricingStateRepository.js';
import { EcbFxService } from '../infrastructure/ecb/EcbFxService.js';
import { ActiveMarketplaceConfig } from '../infrastructure/amazon/MarketplaceConfig.js';
import { SpApiClient } from '../infrastructure/amazon/spApiClient.js';
import { InventorySyncService } from '../application/InventorySyncService.js';
import { FileStockStateStore } from '../infrastructure/filesystem/FileStockStateStore.js';
import logger from '../shared/logger.js';
import { IngramDESupplier } from '../infrastructure/suppliers/ingramDE/IngramDESupplier.js';

const ACTIVE_SKUS_FILE = path.resolve('config', 'active-skus.json');
const flow = 'inventory_worker';
const mode = (process.env.INVENTORY_SYNC_MODE ?? 'hub').toLowerCase();
const reconcileIntervalMs = Number(process.env.INVENTORY_SPOKE_RECONCILE_MS ?? 1800000);

async function loadActiveSkus(): Promise<Set<string>> {
  const raw = await fs.readFile(ACTIVE_SKUS_FILE, 'utf-8');
  return new Set(JSON.parse(raw) as string[]);
}

async function main() {
  logger.info({ flow, event: 'worker_start' }, 'event=worker_start starting inventory sync worker');

  const activeSkus = await loadActiveSkus();
  logger.info({ flow, event: 'active_skus_loaded', count: activeSkus.size }, 'event=active_skus_loaded active SKU list loaded');
  const stateStore = new FileStockStateStore();

  const service = new InventorySyncService(
    [new SitcSupplierSource(new BasicFtpService(STOCK_FTP_CONFIG)), new IngramDESupplier()],
    new DynamoInventoryRepository(),
    new DynamoPricingStateRepository(),
    new DynamoShippingRuleRepository(),
    new DynamoAttributesRepository(),
    new EcbFxService(),
    stateStore,
    new ActiveMarketplaceConfig(),
    new SpApiClient(),
  );

  if (mode === 'hub') {
    await service.runHub(activeSkus);
    return;
  }
  if (mode === 'spoke') {
    await service.startSpokeWatcher(reconcileIntervalMs);
    return;
  }

  throw new Error(`Unknown INVENTORY_SYNC_MODE: ${mode}`);
}

main().catch(err => {
  logger.error({ flow, event: 'worker_failed', err }, 'event=worker_failed inventory sync pipeline failed');
  process.exit(1);
});
