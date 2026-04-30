import { RepriceInstruction, SkuPricingState, PROBING_STATES } from './pricingState.js';
import { ListingOffer, MarketSnapshot } from './types.js';

const MAX_SHIPPING_HOURS = 8 * 24;
const IGNORED_SELLERS = new Set(['A2KVF7QXNCLV8H']);

export interface PricingAuditLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
}

export function auditPricingDecision(
  sku: string,
  event: 'market_snapshot' | 'wake_up',
  previousState: SkuPricingState,
  snapshot: MarketSnapshot,
  instruction: RepriceInstruction,
  logger: PricingAuditLogger,
): void {
  const nextState = instruction.stateToSave;
  const isProbeEchoIgnored =
    event === 'market_snapshot'
    && PROBING_STATES.has(previousState.state)
    && instruction.priceToPush === null
    && instruction.enqueueWakeUpMs === null
    && nextState === previousState;
  const action = isProbeEchoIgnored
    ? 'skip'
    : instruction.priceToPush !== null
      ? 'reprice'
      : 'hold';
  const priceBefore = previousState.currentPrice;
  const priceAfter = nextState.currentPrice;
  const priceDelta = roundCurrency(priceAfter - priceBefore);
  const priceDeltaPct = priceBefore > 0 ? roundPct((priceDelta / priceBefore) * 100) : null;
  const reason = explainDecision(event, previousState, snapshot, instruction, isProbeEchoIgnored);
  const summary = `event=${event} action=${action} state=${previousState.state ?? 'none'}->${nextState.state ?? 'none'} price=${formatMoney(priceBefore)}->${formatMoney(priceAfter)} delta=${formatSignedMoney(priceDelta)}${priceDeltaPct === null ? '' : ` (${formatSignedPct(priceDeltaPct)})`} reason=${reason}`;

  logger.info({
    flow: 'repricer_decision',
    sku,
    event,
    summary,
    reason,
    pricingState: {
      currentPrice: previousState.currentPrice,
      minimumPrice: previousState.minimumPrice,
      state: previousState.state,
      lastPriceSetAt: previousState.lastPriceSetAt,
      lastProcessedAt: previousState.lastProcessedAt,
    },
    marketState: summariseMarket(snapshot),
    decided: {
      action,
      priceToPush: instruction.priceToPush,
      computedPrice: nextState.currentPrice,
      priceDelta,
      priceDeltaPct,
      prevState: previousState.state,
      nextState: nextState.state,
      enqueueWakeUpMs: instruction.enqueueWakeUpMs,
    },
  }, `event=${event} pricing decision recorded`);
}

function explainDecision(
  event: 'market_snapshot' | 'wake_up',
  previousState: SkuPricingState,
  snapshot: MarketSnapshot,
  instruction: RepriceInstruction,
  isProbeEchoIgnored: boolean,
): string {
  const nextState = instruction.stateToSave;
  const harvestClockReset = nextState.lastHarvestStartedAt !== previousState.lastHarvestStartedAt;
  const lurkClockReset = nextState.lastSuppressedProbeAt !== previousState.lastSuppressedProbeAt;

  if (isProbeEchoIgnored) return 'probe echo ignored while waiting for scheduled wake-up';

  if (snapshot.weHaveBuyBox && nextState.state === 'harvesting') {
    if (previousState.state === 'probing_down' || previousState.state === 'attacking') {
      return 'got the buy box; entering harvest window';
    }
    if (!harvestClockReset) {
      return 'holding price during harvest cooldown';
    }
    return 'next climb would overshoot lowest profitable competitor; clamped and harvesting';
  }

  if (snapshot.weHaveBuyBox && nextState.state === 'ceiling_probing') {
    return 'buy box held; stepping up to probe higher ceiling';
  }

  if (!snapshot.weHaveBuyBox && snapshot.buyBoxPrice !== null && nextState.state === 'attacking') {
    return 'buy box visible; targeting competitive attack price';
  }

  if (!snapshot.weHaveBuyBox && snapshot.buyBoxPrice !== null && nextState.state === 'lurking') {
    return 'buy box target is below floor; parking in lurk mode at safe price';
  }

  if (!snapshot.weHaveBuyBox && snapshot.buyBoxPrice === null && nextState.state === 'lurking') {
    if (!lurkClockReset) return 'lurk cooldown active; waiting before next downward probe';
    return 'downward probe reached floor boundary; resetting 7-day lurk cooldown';
  }

  if (!snapshot.weHaveBuyBox && snapshot.buyBoxPrice === null && nextState.state === 'probing_down') {
    if (event === 'wake_up') return 'wake-up tick triggered next downward probe step';
    return 'no buy box signal; probing down to rediscover market';
  }

  if (nextState.state === null) return 'no buy box and no profitable probe remaining; holding floor';
  return 'state machine transition applied';
}

function isEligibleCompetitor(offer: ListingOffer): boolean {
  return offer.ShippingTime.maximumHours <= MAX_SHIPPING_HOURS
    && !IGNORED_SELLERS.has(offer.SellerId);
}

function landedPrice(offer: ListingOffer): number {
  return Math.round((offer.ListingPrice.Amount + offer.Shipping.Amount) * 100) / 100;
}

function summariseMarket(snapshot: MarketSnapshot) {
  const eligibleOffers = snapshot.offers.filter(isEligibleCompetitor);
  const buyBoxWinner = eligibleOffers.find((offer) => offer.IsBuyBoxWinner) ?? null;
  const offerPrices = eligibleOffers.map(landedPrice).sort((a, b) => a - b);
  const sortedEligibleOffers = [...eligibleOffers].sort((a, b) => landedPrice(a) - landedPrice(b));

  return {
    weHaveBuyBox: snapshot.weHaveBuyBox,
    buyBoxPrice: snapshot.buyBoxPrice,
    eligibleOfferCount: offerPrices.length,
    lowestEligibleOffer: offerPrices[0] ?? null,
    highestEligibleOffer: offerPrices[offerPrices.length - 1] ?? null,
    buyBoxWinnerSellerId: buyBoxWinner?.SellerId ?? null,
    buyBoxWinnerIsFBA: buyBoxWinner?.IsFulfilledByAmazon ?? null,
    eligibleOffersSummary: {
      cheapest: sortedEligibleOffers.slice(0, 10).map((offer) => ({
        sellerId: offer.SellerId,
        landedPrice: landedPrice(offer),
        isBuyBoxWinner: offer.IsBuyBoxWinner,
        isFBA: offer.IsFulfilledByAmazon,
      })),
    },
  };
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatMoney(value)}`;
}

function formatSignedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}
