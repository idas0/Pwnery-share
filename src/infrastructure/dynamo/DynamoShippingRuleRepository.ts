import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ShippingRuleRepository } from '../../domains/pricing/ports.js';
import { ShippingRule } from '../../domains/pricing/types.js';
import logger from '../../shared/logger.js';

const TABLE = 'shipping-rules';
const INDEX = 'DistributorMarketplaceIndex';

export class DynamoShippingRuleRepository implements ShippingRuleRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly log = logger.child({ module: 'DynamoShippingRuleRepository' });
  private readonly flow = 'infra_dynamo';

  constructor() {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
      ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
    }));
  }

  async getRule(supplierId: string, marketplaceCode: string): Promise<ShippingRule | null> {
    const result = await this.client.send(new QueryCommand({
      TableName: TABLE,
      IndexName: INDEX,
      KeyConditionExpression: 'distributorId = :d AND marketplaceCode = :m',
      ExpressionAttributeValues: {
        ':d': Number(supplierId),
        ':m': marketplaceCode,
      },
    }));

    const items = result.Items ?? [];
    if (items.length === 0) {
      this.log.debug({
        flow: this.flow,
        event: 'shipping_rule_missing',
        supplierId,
        marketplaceCode,
      }, 'event=shipping_rule_missing no shipping rule found');
      return null;
    }

    const raw = items.find((item) => item['enabled'] !== false);
    if (!raw) {
      return null;
    }

    return {
      supplierId,
      marketplaceCode:             raw['marketplaceCode'],
      enabled:                     raw['enabled'] !== false,
      currency:                    raw['currency'],
      flatShippingCostPerOrder:    raw['flatShippingCostPerOrder'],
      startWeightForPerKgFeeKg:    raw['startWeightForPerKgFeeKg'],
      shippingCostPerKg:           raw['shippingCostPerKg'],
      oversizeOverweightSurcharge: raw['oversizeOverweightSurcharge'],
      hazardousSurcharge:          raw['hazardousSurcharge'],
    };
  }
}
