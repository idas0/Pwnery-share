import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { PricingStateRepository } from '../../domains/pricing/ports.js';
import { SkuPricingState } from '../../domains/pricing/pricingState.js';
import logger from '../../shared/logger.js';

const marketplaceCode = process.env.SP_API_MARKETPLACE_CODE?.toLowerCase();
const TABLE = `pricing-state-${marketplaceCode}`;

function fromItem(item: Record<string, any>): SkuPricingState {
  return {
    currentPrice:       item['currentPrice'],
    minimumPrice:       item['minimumPrice'],
    state:              item['state']           ?? null,
    lastPriceSetAt:     item['lastPriceSetAt']  ?? null,
    lastProcessedAt:    item['lastProcessedAt'] ?? null,
    lastOffers:         item['lastOffers']      ?? [],
    lastBuyBoxPrice:    item['lastBuyBoxPrice']    ?? null,
    lastWeHaveBuyBox:   item['lastWeHaveBuyBox']   ?? null,
    lastOwnBuyBoxPrice: item['lastOwnBuyBoxPrice'] ?? null,
    lastSuppressedProbeAt: item['lastSuppressedProbeAt'] ?? null,
    lastHarvestStartedAt:  item['lastHarvestStartedAt']  ?? null,
  };
}

function toItem(sku: string, state: SkuPricingState, updatedAt: string): Record<string, unknown> {
  return {
    sku,
    currentPrice:       state.currentPrice,
    minimumPrice:       state.minimumPrice,
    state:              state.state,
    lastPriceSetAt:     state.lastPriceSetAt,
    lastProcessedAt:    state.lastProcessedAt,
    lastOffers:         state.lastOffers,
    lastBuyBoxPrice:    state.lastBuyBoxPrice,
    lastWeHaveBuyBox:   state.lastWeHaveBuyBox,
    lastOwnBuyBoxPrice: state.lastOwnBuyBoxPrice,
    lastSuppressedProbeAt: state.lastSuppressedProbeAt,
    lastHarvestStartedAt:  state.lastHarvestStartedAt,
    updatedAt,
  };
}

export class DynamoPricingStateRepository implements PricingStateRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly log = logger.child({ module: 'DynamoPricingStateRepository' });
  private readonly flow = 'infra_dynamo';

  constructor() {
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env.AWS_REGION ?? 'eu-north-1',
        ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
      }),
      {
        marshallOptions: {
          removeUndefinedValues: true,
        },
      },
    );
  }

  async load(sku: string): Promise<SkuPricingState | null> {
    const result = await this.client.send(new GetCommand({
      TableName: TABLE,
      Key: { sku },
    }));

    if (!result.Item) return null;
    return fromItem(result.Item);
  }

  async loadBatch(skus: string[]): Promise<Map<string, SkuPricingState>> {
    const result = new Map<string, SkuPricingState>();
    if (skus.length === 0) return result;

    for (let i = 0; i < skus.length; i += 100) {
      const chunk = skus.slice(i, i + 100);
      const response = await this.client.send(new BatchGetCommand({
        RequestItems: {
          [TABLE]: { Keys: chunk.map(sku => ({ sku })) },
        },
      }));

      for (const item of response.Responses?.[TABLE] ?? []) {
        result.set(item['sku'] as string, fromItem(item));
      }
    }

    return result;
  }

  async save(sku: string, state: SkuPricingState): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: TABLE,
      Item: toItem(sku, state, new Date().toISOString()),
    }));
  }

  async saveBatch(entries: { sku: string; state: SkuPricingState }[]): Promise<void> {
    if (entries.length === 0) return;
    const updatedAt = new Date().toISOString();

    for (let i = 0; i < entries.length; i += 25) {
      const chunk = entries.slice(i, i + 25);
      await this.client.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE]: chunk.map(({ sku, state }) => ({
            PutRequest: { Item: toItem(sku, state, updatedAt) },
          })),
        },
      }));
    }

    this.log.debug({
      flow: this.flow,
      event: 'pricing_state_batch_saved',
      count: entries.length,
    }, 'event=pricing_state_batch_saved saved pricing state batch');
  }

  async deleteBatch(skus: string[]): Promise<void> {
    if (skus.length === 0) return;
    const uniqueSkus = Array.from(new Set(skus));

    for (let i = 0; i < uniqueSkus.length; i += 25) {
      const chunk = uniqueSkus.slice(i, i + 25);
      await this.client.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE]: chunk.map((sku) => ({
            DeleteRequest: { Key: { sku } },
          })),
        },
      }));
    }

    this.log.debug({
      flow: this.flow,
      event: 'pricing_state_batch_deleted',
      count: uniqueSkus.length,
    }, 'event=pricing_state_batch_deleted deleted pricing state batch');
  }
}
