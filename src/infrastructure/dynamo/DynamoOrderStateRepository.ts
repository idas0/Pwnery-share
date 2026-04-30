import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { OrderStateRepository } from '../../domains/ordering/ports.js';
import { OrderRecord, OrderStatus, ShipmentStatus } from '../../domains/ordering/types.js';

export class DynamoOrderStateRepository implements OrderStateRepository {
  private static readonly TABLE_NAME = 'order-state';
  private readonly client: DynamoDBDocumentClient;
  private readonly marketplaceCode: string;

  constructor() {
    const marketplaceCode = process.env.SP_API_MARKETPLACE_CODE?.toUpperCase();
    if (!marketplaceCode) {
      throw new Error('DynamoOrderStateRepository: SP_API_MARKETPLACE_CODE is required');
    }
    this.marketplaceCode = marketplaceCode;

    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env.AWS_REGION ?? 'eu-north-1',
        ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
      }),
    );
  }

  async get(orderId: string): Promise<OrderRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: DynamoOrderStateRepository.TABLE_NAME,
        Key: { marketplaceCode: this.marketplaceCode, orderId },
      }),
    );
    if (!result.Item) return null;
    return result.Item as OrderRecord;
  }

  async upsertUploaded(
    orderId: string,
    data: Omit<
      OrderRecord,
      | 'orderId'
      | 'status'
      | 'createdAt'
      | 'updatedAt'
      | 'failureReason'
      | 'retryCount'
      | 'deadlineAlerted'
    >,
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(orderId);

    if (!existing) {
      const item: Record<string, unknown> = {
        orderId,
        marketplaceCode: this.marketplaceCode,
        status:          'uploaded',
        createdAt:       now,
        updatedAt:       now,
        retryCount:      0,
        customerName:    data.customerName,
        customerCountry: data.customerCountry,
        items:           data.items,
      };
      if (data.supplierId !== undefined) item.supplierId = data.supplierId;
      if (data.supplierOrderId !== undefined) item.supplierOrderId = data.supplierOrderId;
      if (data.latestShipDate !== undefined) item.latestShipDate = data.latestShipDate;
      await this.client.send(new PutCommand({ TableName: DynamoOrderStateRepository.TABLE_NAME, Item: item }));
      return;
    }

    const names: Record<string, string> = { '#status': 'status' };
    const values: Record<string, unknown> = {
      ':uploaded': 'uploaded',
      ':now':      now,
      ':sid':      data.supplierId ?? null,
      ':soid':     data.supplierOrderId ?? null,
      ':cn':       data.customerName,
      ':cc':       data.customerCountry,
      ':items':    data.items,
      ':rc0':      0,
    };

    let updateExpr =
      'SET #status = :uploaded, updatedAt = :now, supplierId = :sid, supplierOrderId = :soid, customerName = :cn, customerCountry = :cc, items = :items, retryCount = :rc0';

    if (data.latestShipDate !== undefined) {
      updateExpr += ', latestShipDate = :lsd';
      values[':lsd'] = data.latestShipDate;
    }

    const removeAttrs = ['failureReason'];
    if (data.latestShipDate === undefined) removeAttrs.push('latestShipDate');
    updateExpr += ` REMOVE ${removeAttrs.join(', ')}`;

    await this.client.send(
      new UpdateCommand({
        TableName:                 DynamoOrderStateRepository.TABLE_NAME,
        Key:                       { marketplaceCode: this.marketplaceCode, orderId },
        UpdateExpression:          updateExpr,
        ExpressionAttributeNames:  names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async upsertFailed(orderId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(orderId);

    if (!existing) {
      await this.client.send(
        new PutCommand({
          TableName: DynamoOrderStateRepository.TABLE_NAME,
          Item: {
            orderId,
            marketplaceCode: this.marketplaceCode,
            status:          'failed',
            failureReason:   reason,
            createdAt:       now,
            updatedAt:       now,
            customerName:    '',
            customerCountry: '',
            items:           [],
          },
        }),
      );
      return;
    }

    await this.client.send(
      new UpdateCommand({
        TableName: DynamoOrderStateRepository.TABLE_NAME,
        Key:       { marketplaceCode: this.marketplaceCode, orderId },
        UpdateExpression:
          'SET #status = :failed, failureReason = :reason, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':reason': reason,
          ':now':    now,
        },
      }),
    );
  }

  async markShipped(orderId: string, tracking: ShipmentStatus): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(orderId);
    if (!existing) {
      throw new Error(`DynamoOrderStateRepository.markShipped: no row for orderId ${orderId}`);
    }

    await this.client.send(
      new UpdateCommand({
        TableName: DynamoOrderStateRepository.TABLE_NAME,
        Key:       { marketplaceCode: this.marketplaceCode, orderId },
        UpdateExpression:
          'SET #status = :shipped, shippedAt = :now, updatedAt = :now, trackingNumber = :tn, carrierCode = :cc, carrierName = :cn, shipDate = :sd',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':shipped': 'shipped',
          ':now':     now,
          ':tn':      tracking.trackingNumber,
          ':cc':      tracking.carrierCode,
          ':cn':      tracking.carrierName,
          ':sd':      tracking.shipDate,
        },
      }),
    );
  }

  async markRetryPending(orderId: string, retryCount: number, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(orderId);

    if (!existing) {
      await this.client.send(
        new PutCommand({
          TableName: DynamoOrderStateRepository.TABLE_NAME,
          Item: {
            orderId,
            marketplaceCode: this.marketplaceCode,
            status:          'retry_pending',
            retryCount,
            failureReason:   reason,
            createdAt:       now,
            updatedAt:       now,
            customerName:    '',
            customerCountry: '',
            items:           [],
          },
        }),
      );
      return;
    }

    await this.client.send(
      new UpdateCommand({
        TableName: DynamoOrderStateRepository.TABLE_NAME,
        Key:       { marketplaceCode: this.marketplaceCode, orderId },
        UpdateExpression:
          'SET #status = :rp, failureReason = :reason, retryCount = :rc, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':rp':     'retry_pending',
          ':reason': reason,
          ':rc':     retryCount,
          ':now':    now,
        },
      }),
    );
  }

  async markDeadlineAlerted(orderId: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(orderId);
    if (!existing) {
      throw new Error(`DynamoOrderStateRepository.markDeadlineAlerted: no row for orderId ${orderId}`);
    }

    await this.client.send(
      new UpdateCommand({
        TableName: DynamoOrderStateRepository.TABLE_NAME,
        Key:       { marketplaceCode: this.marketplaceCode, orderId },
        UpdateExpression:         'SET deadlineAlerted = :yes, updatedAt = :now',
        ExpressionAttributeValues: {
          ':yes': true,
          ':now': now,
        },
      }),
    );
  }

  async getByStatus(status: OrderStatus): Promise<OrderRecord[]> {
    const out: OrderRecord[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: DynamoOrderStateRepository.TABLE_NAME,
          IndexName: 'MarketplaceStatusIndex',
          KeyConditionExpression: 'marketplaceCode = :m AND #status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':m': this.marketplaceCode,
            ':status': status,
          },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );

      for (const item of result.Items ?? []) {
        out.push(item as OrderRecord);
      }

      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return out;
  }

  async detectTimedOut(timeoutMinutes: number): Promise<string[]> {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const now = Date.now();
    const timedOutOrderIds: string[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: DynamoOrderStateRepository.TABLE_NAME,
          KeyConditionExpression: 'marketplaceCode = :m',
          FilterExpression: '#status = :uploading',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':m': this.marketplaceCode,
            ':uploading': 'uploading',
          },
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        }),
      );

      for (const raw of result.Items ?? []) {
        const orderId = raw['orderId'] as string | undefined;
        const updatedAt = raw['updatedAt'] as string | undefined;
        if (!orderId || !updatedAt) continue;

        const ageMs = now - new Date(updatedAt).getTime();
        if (ageMs <= timeoutMs) continue;

        const nextRetry = (typeof raw['retryCount'] === 'number' ? raw['retryCount'] : 0) + 1;
        const nowIso = new Date().toISOString();
        const reason = `Timeout: no update for ${timeoutMinutes} minutes`;

        await this.client.send(
          new UpdateCommand({
            TableName: DynamoOrderStateRepository.TABLE_NAME,
            Key:       { marketplaceCode: this.marketplaceCode, orderId },
            UpdateExpression:
              'SET #status = :rp, retryCount = :rc, failureReason = :reason, updatedAt = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':rp':     'retry_pending',
              ':rc':     nextRetry,
              ':reason': reason,
              ':now':    nowIso,
            },
          }),
        );

        timedOutOrderIds.push(orderId);
      }

      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return timedOutOrderIds;
  }
}
