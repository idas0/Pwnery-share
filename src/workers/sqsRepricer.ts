import 'dotenv/config';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SqsConsumer } from '../infrastructure/sqs/SqsConsumer.js';
import { SqsPublisher } from '../infrastructure/sqs/SqsPublisher.js';
import { DynamoPricingStateRepository } from '../infrastructure/dynamo/DynamoPricingStateRepository.js';
import { DynamoB2BPricingStateRepository } from '../infrastructure/dynamo/DynamoB2BPricingStateRepository.js';
import { DynamoAttributesRepository } from '../infrastructure/dynamo/DynamoAttributesRepository.js';
import { DynamoInventoryRepository } from '../infrastructure/dynamo/DynamoInventoryRepository.js';
import { DynamoShippingRuleRepository } from '../infrastructure/dynamo/DynamoShippingRuleRepository.js';
import { ActiveMarketplaceConfig } from '../infrastructure/amazon/MarketplaceConfig.js';
import { SpApiClient } from '../infrastructure/amazon/spApiClient.js';
import { EcbFxService } from '../infrastructure/ecb/EcbFxService.js';
import { PricingService } from '../application/PricingService.js';
import logger from '../shared/logger.js';

const log = logger.child({ worker: 'sqsRepricer' });
const flow = 'repricer_worker';

const sqsClient      = new SQSClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
const schedulerClient = new SchedulerClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });
const stateRepo      = new DynamoPricingStateRepository();
const b2bStateRepo   = new DynamoB2BPricingStateRepository();
const inventoryRepo  = new DynamoInventoryRepository();
const shippingRules  = new DynamoShippingRuleRepository();
const attributesRepo = new DynamoAttributesRepository();
const exchangeRates  = new EcbFxService();
const marketplaceConfig = new ActiveMarketplaceConfig();
const activeMarketplace = marketplaceConfig.getActive();
const marketplace      = new SpApiClient();
const publisher      = new SqsPublisher(
  schedulerClient,
  process.env.SQS_QUEUE_ARN,
  process.env.EVENTBRIDGE_SCHEDULER_ROLE_ARN,
  process.env.EVENTBRIDGE_SCHEDULER_GROUP_NAME ?? 'default',
);

const pricingService = new PricingService(
  stateRepo,
  b2bStateRepo,
  inventoryRepo,
  shippingRules,
  attributesRepo,
  exchangeRates,
  marketplaceConfig,
  publisher,
  marketplace,
  process.env.SP_API_SELLER_ID!,
  activeMarketplace.currencyCode,
);

const consumer = new SqsConsumer(
  sqsClient,
  process.env.SQS_QUEUE_URL!,
  attributesRepo,
  (sku, payload)      => pricingService.handleMarketUpdate(sku, payload),
  (sku, payload)      => pricingService.handleB2BMarketUpdate(sku, payload),
  (sku, triggeredAt)  => pricingService.handleWakeUp(sku, triggeredAt),
);

export async function startRepricer(): Promise<void> {
  if (!process.env.SQS_QUEUE_URL)    throw new Error('SQS_QUEUE_URL env var is required');
  if (!process.env.SQS_QUEUE_ARN)    throw new Error('SQS_QUEUE_ARN env var is required');
  if (!process.env.EVENTBRIDGE_SCHEDULER_ROLE_ARN) throw new Error('EVENTBRIDGE_SCHEDULER_ROLE_ARN env var is required');
  if (!process.env.SP_API_SELLER_ID) throw new Error('SP_API_SELLER_ID env var is required');

  log.info({ flow, event: 'worker_start' }, 'event=worker_start starting repricer worker');
  await attributesRepo.warmAsinCache();
  log.info({ flow, event: 'asin_cache_warmed' }, 'event=asin_cache_warmed attributes cache warmed');
  await consumer.start();
}

export function stopRepricer(): void {
  consumer.stop();
}

startRepricer().catch(err => {
  log.error({ flow, event: 'worker_crashed', err }, 'event=worker_crashed repricer worker crashed');
  process.exit(1);
});
