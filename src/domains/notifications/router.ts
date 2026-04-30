import { MARKETPLACES } from '../../shared/config.js';

type AnyOfferEnvelope = {
  NotificationType?: string;
  Payload?: {
    AnyOfferChangedNotification?: {
      OfferChangeTrigger?: { MarketplaceId?: string };
    };
    B2BAnyOfferChangedNotification?: {
      OfferChangeTrigger?: { MarketplaceId?: string };
    };
  };
};

export function marketplaceQueueMapFromEnv(env: NodeJS.ProcessEnv): Map<string, string> {
  const map = new Map<string, string>();
  for (const marketplace of MARKETPLACES) {
    const queueUrl = env[`SQS_QUEUE_URL_${marketplace.marketplaceCode}`] ?? '';
    if (!queueUrl) continue;
    map.set(marketplace.amazonMarketplaceId, queueUrl);
  }
  return map;
}

export function extractMarketplaceIdFromSqsBody(body: string): string | null {
  const parsed = JSON.parse(body) as { Message?: string } & AnyOfferEnvelope;
  const envelope: AnyOfferEnvelope = parsed.Message
    ? JSON.parse(parsed.Message) as AnyOfferEnvelope
    : parsed;
  if (envelope.NotificationType === 'ANY_OFFER_CHANGED') {
    return envelope.Payload?.AnyOfferChangedNotification?.OfferChangeTrigger?.MarketplaceId ?? null;
  }
  if (envelope.NotificationType === 'B2B_ANY_OFFER_CHANGED') {
    return envelope.Payload?.B2BAnyOfferChangedNotification?.OfferChangeTrigger?.MarketplaceId ?? null;
  }
  return null;
}
