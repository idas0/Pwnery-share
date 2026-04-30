import * as dotenv from 'dotenv';
dotenv.config();

import { OrderFulfillmentService } from '../application/OrderFulfillmentService.js';
import { DeadlineAlertService } from '../application/DeadlineAlertService.js';
import { SpApiClient } from '../infrastructure/amazon/spApiClient.js';
import { DiscordNotifier } from '../infrastructure/discord/DiscordNotifier.js';
import { DynamoOrderStateRepository } from '../infrastructure/dynamo/DynamoOrderStateRepository.js';
import { DynamoInventoryRepository } from '../infrastructure/dynamo/DynamoInventoryRepository.js';
import { BasicFtpService } from '../infrastructure/ftp/BasicFtpService.js';
import { IngramDESupplier } from '../infrastructure/suppliers/ingramDE/IngramDESupplier.js';
import { WortmannSupplier } from '../infrastructure/suppliers/wortmann/WortmannSupplier.js';
import { WORTMANN_EUR_CONFIG, WORTMANN_GBP_CONFIG } from '../infrastructure/suppliers/wortmann/config.js';
import logger from '../shared/logger.js';

const log = logger.child({ worker: 'orderFulfillment' });
const flow = 'order_fulfillment_worker';

async function main(): Promise<void> {
  const startedAt = Date.now();
  log.info({ flow, event: 'worker_start' }, 'event=worker_start starting order fulfillment worker');

  const marketplace = new SpApiClient();
  const orderStateRepo = new DynamoOrderStateRepository();
  const inventoryRepo = new DynamoInventoryRepository();
  const notifier = new DiscordNotifier();
  const suppliers = [
    new WortmannSupplier(
      new BasicFtpService(WORTMANN_EUR_CONFIG),
      new BasicFtpService(WORTMANN_GBP_CONFIG),
    ),
    new IngramDESupplier(),
  ];
  log.info({
    flow,
    event: 'worker_dependencies_ready',
    supplierIds: suppliers.map((supplier) => supplier.supplierId),
  }, 'event=worker_dependencies_ready worker dependencies initialized');

  const fulfillmentService = new OrderFulfillmentService(
    marketplace,
    orderStateRepo,
    inventoryRepo,
    suppliers,
    notifier,
  );
  const deadlineService = new DeadlineAlertService(orderStateRepo, notifier);

  await fulfillmentService.run();
  await deadlineService.run();

  log.info({ flow, event: 'worker_complete', durationMs: Date.now() - startedAt }, 'event=worker_complete order fulfillment worker completed');
}

main().catch(err => {
  log.error({ flow, event: 'worker_crash', err }, 'event=worker_crash order fulfillment worker crashed');
  process.exit(1);
});
