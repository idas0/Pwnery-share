import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { B2BPricingState } from '../../domains/pricing/b2bPricing.js';
import { B2BPricingStateRepository } from '../../domains/pricing/ports.js';
import logger from '../../shared/logger.js';

const marketplaceCode = process.env.SP_API_MARKETPLACE_CODE?.toLowerCase();
const TABLE = `b2b-pricing-state-${marketplaceCode}`;

function fromItem(item: Record<string, any>): B2BPricingState {
  return {
    lastTierSchedule: item['lastTierSchedule'] ?? [],
    lastB2BOffers:    item['lastB2BOffers']    ?? [],
  };
}

export class DynamoB2BPricingStateRepository implements B2BPricingStateRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly log = logger.child({ module: 'DynamoB2BPricingStateRepository' });
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

  async load(sku: string): Promise<B2BPricingState | null> {
    const result = await this.client.send(new GetCommand({
      TableName: TABLE,
      Key: { sku },
    }));
    return result.Item ? fromItem(result.Item) : null;
  }

  async save(sku: string, state: B2BPricingState): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: TABLE,
      Item: {
        sku,
        lastTierSchedule: state.lastTierSchedule,
        lastB2BOffers:    state.lastB2BOffers,
        updatedAt:        new Date().toISOString(),
      },
    }));
    this.log.debug({
      flow: this.flow,
      event: 'b2b_pricing_state_saved',
      sku,
    }, 'event=b2b_pricing_state_saved saved B2B pricing state');
  }
}
