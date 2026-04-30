import { ShippingRule, ItemAttributes, Marketplace } from './types.js';
import { SkuPricingState } from './pricingState.js';
import { B2BPricingState } from './b2bPricing.js';

export interface ShippingRuleRepository {
  getRule(supplierId: string, marketplaceCode: string): Promise<ShippingRule | null>;
}

export interface AttributesRepository {
  getAttributes(sku: string): Promise<ItemAttributes | null>;
  getAttributesBatch(skus: string[]): Promise<Map<string, ItemAttributes>>;
  asinToSku(asin: string): Promise<string | null>;
  warmAsinCache(): Promise<void>;
}

export interface ExchangeRateRepository {
  getRate(from: string, to: string): Promise<number>;
}

export interface MarketplaceConfig {
  getActive(): Marketplace;
}

export interface PricingStateRepository {
  load(sku: string): Promise<SkuPricingState | null>;
  loadBatch(skus: string[]): Promise<Map<string, SkuPricingState>>;
  save(sku: string, state: SkuPricingState): Promise<void>;
  saveBatch(entries: { sku: string; state: SkuPricingState }[]): Promise<void>;
  deleteBatch(skus: string[]): Promise<void>;
}

export interface B2BPricingStateRepository {
  load(sku: string): Promise<B2BPricingState | null>;
  save(sku: string, state: B2BPricingState): Promise<void>;
}
