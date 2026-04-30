import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, BatchGetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AttributesRepository } from '../../domains/pricing/ports.js';
import { ItemAttributes } from '../../domains/pricing/types.js';
import logger from '../../shared/logger.js';

const TABLE = 'item-attributes';
const BATCH_SIZE = 100;

export class DynamoAttributesRepository implements AttributesRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly log = logger.child({ module: 'DynamoAttributesRepository' });
  private readonly flow = 'infra_dynamo';

  constructor() {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
      ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
    }));
  }

  async getAttributes(sku: string): Promise<ItemAttributes | null> {
    const result = await this.client.send(new GetCommand({
      TableName: TABLE,
      Key: { sku },
    }));
    return result.Item ? this.map(result.Item) : null;
  }

  async getAttributesBatch(skus: string[]): Promise<Map<string, ItemAttributes>> {
    const result = new Map<string, ItemAttributes>();
    if (skus.length === 0) return result;

    for (let i = 0; i < skus.length; i += BATCH_SIZE) {
      const batch = skus.slice(i, i + BATCH_SIZE);
      const resp = await this.client.send(new BatchGetCommand({
        RequestItems: {
          [TABLE]: { Keys: batch.map(sku => ({ sku })) },
        },
      }));

      for (const raw of resp.Responses?.[TABLE] ?? []) {
        const attrs = this.map(raw);
        result.set(attrs.sku, attrs);
      }
    }

    this.log.debug({
      flow: this.flow,
      event: 'attributes_batch_fetched',
      requested: skus.length,
      found: result.size,
    }, 'event=attributes_batch_fetched fetched item attributes batch');
    return result;
  }

  private asinSkuCache: Map<string, string> | null = null;

  async warmAsinCache(): Promise<void> {
    this.asinSkuCache = await this.buildAsinSkuCache();
    this.log.debug({
      flow: this.flow,
      event: 'asin_cache_warmed',
      size: this.asinSkuCache.size,
    }, 'event=asin_cache_warmed ASIN to SKU cache warmed');
  }

  async asinToSku(asin: string): Promise<string | null> {
    if (!this.asinSkuCache) {
      this.asinSkuCache = await this.buildAsinSkuCache();
    }
    return this.asinSkuCache.get(asin) ?? null;
  }

  private async buildAsinSkuCache(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(new ScanCommand({
        TableName: TABLE,
        ProjectionExpression: 'sku, asin',
        ExclusiveStartKey: lastKey,
      }));

      for (const item of result.Items ?? []) {
        if (item['asin'] && item['sku']) {
          map.set(item['asin'] as string, item['sku'] as string);
        }
      }

      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return map;
  }

  private map(raw: Record<string, any>): ItemAttributes {
    return {
      sku:                     raw['sku'],
      weightKg:                raw['weightKg']      ?? 0,
      isOversize:              raw['isOversize']     === 1,
      isHazardous:             raw['hazardous']      === 1,
      referralFeeFirstHundred: raw['firstHundredFee'] ?? 0,
      referralFeeRemaining:    raw['remainingFee']    ?? 0,
    };
  }
}
