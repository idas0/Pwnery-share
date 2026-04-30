import { PricingStateRepository, B2BPricingStateRepository, ShippingRuleRepository, AttributesRepository, ExchangeRateRepository, MarketplaceConfig } from '../domains/pricing/ports.js';
import type { Marketplace as MarketplaceClient } from '../domains/ordering/ports.js';
import { RepriceInstruction, processMarketSnapshot, processWakeUp } from '../domains/pricing/pricingState.js';
import { auditPricingDecision } from '../domains/pricing/pricingAuditor.js';
import { processB2BSnapshot, buildB2BCompetitorMap, B2BCalculationContext } from '../domains/pricing/b2bPricing.js';
import { buildSnapshot, buildB2BSnapshot, AnyOfferChangedPayload, B2BAnyOfferChangedPayload } from '../infrastructure/amazon/snapshotBuilder.js';
import { SqsPublisher } from '../infrastructure/sqs/SqsPublisher.js';
import logger from '../shared/logger.js';
import { MarketSnapshot } from '../domains/pricing/types.js';
import { InventoryRepository } from '../domains/inventory/ports.js';

const log = logger.child({ service: 'PricingService' });
const flow = 'repricer_pricing';
type B2BTrigger = 'b2c_price_change' | 'b2b_market_update';

export class PricingService {
  constructor(
    private readonly stateRepo:    PricingStateRepository,
    private readonly b2bStateRepo: B2BPricingStateRepository,
    private readonly inventoryRepo: InventoryRepository,
    private readonly shippingRules: ShippingRuleRepository,
    private readonly attributes:    AttributesRepository,
    private readonly exchangeRates: ExchangeRateRepository,
    private readonly marketplaceConfig: MarketplaceConfig,
    private readonly publisher:    SqsPublisher,
    private readonly marketplace:  MarketplaceClient,
    private readonly sellerId:     string,
    private readonly currencyCode: string,
  ) {}

  async handleMarketUpdate(sku: string, payload: AnyOfferChangedPayload): Promise<void> {
    const state = await this.stateRepo.load(sku);
    if (!state) {
      return;
    }

    const snapshot    = buildSnapshot(payload, this.sellerId);
    const instruction = processMarketSnapshot(state, snapshot);
    auditPricingDecision(sku, 'market_snapshot', state, snapshot, instruction, log);
    await this.executeInstruction(sku, instruction);

    // Cascade B2B reprice if consumer price changed — B2B anchor is derived from consumer price
    if (instruction.priceToPush !== null) {
      await this.repriceB2B(
        sku,
        instruction.stateToSave.currentPrice,
        instruction.stateToSave.minimumPrice,
        null,
        'b2c_price_change',
      );
    }
  }

  async handleB2BMarketUpdate(sku: string, payload: B2BAnyOfferChangedPayload): Promise<void> {
    const state = await this.stateRepo.load(sku);
    if (!state) {
      return;
    }

    const snapshot = buildB2BSnapshot(payload, this.sellerId);
    await this.repriceB2B(
      sku,
      state.currentPrice,
      state.minimumPrice,
      snapshot.offers,
      'b2b_market_update',
    );
  }

  async handleWakeUp(
    sku: string,
    triggeredAt: number,
  ): Promise<void> {
    const state = await this.stateRepo.load(sku);
    if (!state) return;

    if (state.lastProcessedAt !== null && state.lastProcessedAt > triggeredAt) {
      log.debug({ flow, event: 'wakeup_stale', sku, triggeredAt }, 'event=wakeup_stale stale wake-up ignored');
      return;
    }

    const instruction = processWakeUp(state);
    const wakeUpSnapshot: MarketSnapshot = {
      offers: state.lastOffers,
      buyBoxPrice: state.lastBuyBoxPrice,
      weHaveBuyBox: state.lastWeHaveBuyBox ?? false,
    };
    auditPricingDecision(sku, 'wake_up', state, wakeUpSnapshot, instruction, log);
    await this.executeInstruction(sku, instruction);
  }

  private async repriceB2B(
    sku: string,
    b2cCurrentPrice: number,
    b2cFloor: number,
    freshOffers: import('../domains/pricing/types.js').B2BOffer[] | null,
    trigger: B2BTrigger,
  ): Promise<void> {
    const lastB2BState = await this.b2bStateRepo.load(sku);
    const offers       = freshOffers ?? lastB2BState?.lastB2BOffers ?? [];
    const context = await this.buildB2BContext(sku, b2cCurrentPrice, b2cFloor);
    if (!context) {
      log.warn({ flow, event: 'b2b_context_missing', sku }, 'event=b2b_context_missing missing B2B dependencies, skipping B2B reprice');
      return;
    }

    const instruction = processB2BSnapshot(context, offers, lastB2BState);
    const competitorMap = buildB2BCompetitorMap(offers);
    const competitorLevels = Array.from(competitorMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([qty, price]) => ({ qty, landedPrice: price }));

    if (instruction.scheduleChanged) {
      const singleUnitPrice = instruction.tierSchedule.find(t => t.qty === 1)?.price;
      if (singleUnitPrice === undefined) throw new Error(`B2B tier schedule missing qty=1 for SKU ${sku}`);
      const quantityTiers = instruction.tierSchedule.filter(t => t.qty > 1);
      log.debug({
        flow,
        event: 'b2b_reprice_applied',
        sku,
        trigger,
        b2cCurrentPrice,
        b2cFloor,
        offerCount: offers.length,
        competitorLevels,
        singleUnitPrice,
        tierSchedule: instruction.tierSchedule,
        previousTierSchedule: lastB2BState?.lastTierSchedule ?? [],
      }, 'event=b2b_reprice_applied B2B reprice applied');
      await this.marketplace.updateB2BPrice(sku, singleUnitPrice, quantityTiers, this.currencyCode);
    } else {
      log.debug({
        flow,
        event: 'b2b_schedule_unchanged',
        sku,
        trigger,
        b2cCurrentPrice,
        b2cFloor,
        offerCount: offers.length,
        competitorLevels,
        tierSchedule: instruction.tierSchedule,
      }, 'event=b2b_schedule_unchanged B2B tier schedule unchanged');
    }

    await this.b2bStateRepo.save(sku, {
      lastTierSchedule: instruction.tierSchedule,
      lastB2BOffers:    freshOffers ?? lastB2BState?.lastB2BOffers ?? [],
    });
  }

  private async buildB2BContext(
    sku: string,
    b2cCurrentPrice: number,
    b2cFloor: number,
  ): Promise<B2BCalculationContext | null> {
    const stockItem = await this.inventoryRepo.getBySku(sku);
    if (!stockItem) return null;
    const activeMarketplace = this.marketplaceConfig.getActive();
    const attrs = await this.attributes.getAttributes(sku);
    if (!attrs) return null;
    const rule = await this.shippingRules.getRule(stockItem.supplierId, activeMarketplace.marketplaceCode);
    if (!rule) return null;
    const supplierToMarketplaceRate = rule.currency === activeMarketplace.currencyCode
      ? 1
      : await this.exchangeRates.getRate(rule.currency, activeMarketplace.currencyCode);
    return {
      baseCost: stockItem.cost,
      supplierToMarketplaceRate,
      attrs,
      rule,
      marketplace: activeMarketplace,
      b2cFloor,
      b2cCurrentPrice,
    };
  }

  private async executeInstruction(sku: string, instruction: RepriceInstruction): Promise<void> {
    if (instruction.priceToPush !== null) {
      log.debug({
        flow,
        event: 'reprice_applied',
        sku,
        price: instruction.priceToPush,
        state: instruction.stateToSave.state,
      }, 'event=reprice_applied reprice instruction applied');
      await this.marketplace.updatePrice(sku, instruction.priceToPush, this.currencyCode);
    } else {
      log.debug({ flow, event: 'reprice_skipped', sku, state: instruction.stateToSave.state }, 'event=reprice_skipped no price update required');
    }

    await this.stateRepo.save(sku, instruction.stateToSave);

    if (instruction.enqueueWakeUpMs !== null) {
      await this.publisher.enqueueTimeout(
        sku,
        instruction.enqueueWakeUpMs,
      );
      log.debug({ flow, event: 'wakeup_requested', sku, delayMs: instruction.enqueueWakeUpMs }, 'event=wakeup_requested wake-up scheduling requested');
    }
  }
}
