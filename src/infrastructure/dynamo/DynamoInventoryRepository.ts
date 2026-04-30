import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { InventoryRepository } from '../../domains/inventory/ports.js';
import { CatalogItem } from '../../domains/shared/types.js';
import logger from '../../shared/logger.js';

const SNAPSHOT_ID_PK = '_SNAPSHOT_ID_';

export class DynamoInventoryRepository implements InventoryRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly log = logger.child({ module: 'DynamoInventoryRepository' });
  private readonly flow = 'infra_dynamo';

  constructor() {
    const marketplaceCode = process.env.SP_API_MARKETPLACE_CODE?.toLowerCase();
    if (!marketplaceCode) {
      throw new Error('SP_API_MARKETPLACE_CODE env var is required for DynamoInventoryRepository');
    }
    this.tableName = `inventory-items-${marketplaceCode}`;
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
      ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
    }));
  }

  async getAll(): Promise<CatalogItem[]> {
    const items: CatalogItem[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: lastKey,
      }));

      for (const raw of result.Items ?? []) {
        if (raw['sku'] === SNAPSHOT_ID_PK) {
          continue;
        }
        items.push({
          sku:         raw['sku'],
          supplierId:  raw['supplierId'],
          supplierSku: raw['supplierSku'],
          stock:       raw['stock'],
          cost:        raw['cost'],
        });
      }

      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    this.log.debug({
      flow: this.flow,
      event: 'inventory_loaded',
      count: items.length,
    }, 'event=inventory_loaded loaded stored inventory items from DynamoDB');

    return items;
  }

  async getBySku(sku: string): Promise<CatalogItem | null> {
    if (sku === SNAPSHOT_ID_PK) return null;
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { sku },
    }));
    if (!result.Item) return null;
    const raw = result.Item;
    return {
      sku:         raw['sku'],
      supplierId:  raw['supplierId'],
      supplierSku: raw['supplierSku'],
      stock:       raw['stock'],
      cost:        raw['cost'],
    };
  }

  async getBatchBySku(skus: string[]): Promise<CatalogItem[]> {
    const result: CatalogItem[] = [];
    const uniqueSkus = Array.from(new Set(skus))
      .filter((sku) => sku !== SNAPSHOT_ID_PK);
    if (uniqueSkus.length === 0) return result;

    for (let i = 0; i < uniqueSkus.length; i += 100) {
      const chunk = uniqueSkus.slice(i, i + 100);
      const response = await this.client.send(new BatchGetCommand({
        RequestItems: {
          [this.tableName]: { Keys: chunk.map((sku) => ({ sku })) },
        },
      }));

      for (const raw of response.Responses?.[this.tableName] ?? []) {
        result.push({
          sku: raw['sku'],
          supplierId: raw['supplierId'],
          supplierSku: raw['supplierSku'],
          stock: raw['stock'],
          cost: raw['cost'],
        });
      }
    }

    return result;
  }

  async getSnapshotId(): Promise<string | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { sku: SNAPSHOT_ID_PK },
    }));
    if (!result.Item) return null;
    const snapshotId = result.Item['snapshotId'];
    return typeof snapshotId === 'string' ? snapshotId : null;
  }

  async setSnapshotId(snapshotId: string): Promise<void> {
    await this.client.send(new BatchWriteCommand({
      RequestItems: {
        [this.tableName]: [{
          PutRequest: {
            Item: {
              sku: SNAPSHOT_ID_PK,
              snapshotId,
            },
          },
        }],
      },
    }));
  }

  async saveAll(items: CatalogItem[]): Promise<void> {
    if (items.length === 0) return;
    const lastSyncedAt = new Date().toISOString();

    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await this.client.send(new BatchWriteCommand({
        RequestItems: {
          [this.tableName]: chunk.map(item => ({
            PutRequest: {
              Item: {
                sku:          item.sku,
                supplierId:   item.supplierId,
                supplierSku:  item.supplierSku,
                stock:        item.stock,
                cost:         item.cost,
                lastSyncedAt,
              },
            },
          })),
        },
      }));
    }

    this.log.debug({
      flow: this.flow,
      event: 'inventory_saved',
      count: items.length,
    }, 'event=inventory_saved saved catalog items to DynamoDB');
  }
}
