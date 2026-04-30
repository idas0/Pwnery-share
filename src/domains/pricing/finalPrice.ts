import { CatalogItem } from '../shared/types.js';
import { ShippingRule, ItemAttributes, Marketplace } from './types.js';
import {
  ShippingRuleRepository,
  AttributesRepository,
  ExchangeRateRepository,
  MarketplaceConfig,
} from './ports.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeShippingFee(attrs: ItemAttributes, qty: number, rule: ShippingRule): number {
  const totalWeightKg = attrs.weightKg * qty;
  const hazardousFee = attrs.isHazardous ? rule.hazardousSurcharge * qty : 0;
  const oversizeFee = attrs.isOversize ? rule.oversizeOverweightSurcharge * qty : 0;
  const usePerKgBranch = rule.shippingCostPerKg > 0 && totalWeightKg >= rule.startWeightForPerKgFeeKg;
  if (!usePerKgBranch) {
    const boxes = Math.ceil(totalWeightKg / 20) || 1;
    return rule.flatShippingCostPerOrder * boxes + hazardousFee + oversizeFee;
  }
  return totalWeightKg * rule.shippingCostPerKg + hazardousFee + oversizeFee;
}

export function applyMarketplaceFeesAndVat(
  totalCost: number,
  attrs: ItemAttributes,
  marketplace: Marketplace,
): number {
  const f1 = attrs.referralFeeFirstHundred / 100;
  const f2 = attrs.referralFeeRemaining / 100;
  const v  = marketplace.vatFraction;
  const priceUnder100 = totalCost / (1 - v - f1);
  if (priceUnder100 <= 100) {
    return round(priceUnder100);
  }
  return round((totalCost + 100 * (f1 - f2)) / (1 - v - f2));
}

export function computeDynamicMarkup(
  costInMarketplaceCurrency: number,
  qty: number,
  floorMargin: number = 0.045,
  ceilingMargin: number = 0.40,
  decayRate: number = 35, //should be midpoint of floor and ceiling margin
): number {
  if (costInMarketplaceCurrency <= 0) {
    throw new Error(`CRITICAL ABORT: Base cost is ${costInMarketplaceCurrency}.`);
  }
  const bulkCost = costInMarketplaceCurrency * qty;
  const targetMarginFraction = floorMargin
    + (ceilingMargin - floorMargin) / (1 + (bulkCost / decayRate));
  return bulkCost * targetMarginFraction;
}

export function computeFinalPrice(
  costInSupplierCurrency: number,
  supplierToMarketplace: number,
  attrs: ItemAttributes,
  rule: ShippingRule,
  marketplace: Marketplace,
): number {
  const costInMarketplaceCurrency = costInSupplierCurrency * supplierToMarketplace;
  const shippingFee = computeShippingFee(attrs, 1, rule) * supplierToMarketplace;
  const markup = computeDynamicMarkup(
    costInMarketplaceCurrency,
    1,
  );
  const totalCost = costInMarketplaceCurrency + markup + shippingFee;
  return applyMarketplaceFeesAndVat(totalCost, attrs, marketplace);
}

export interface ItemsWithMinimumPrice {
  item: CatalogItem;
  minimumPrice: number;
}

export async function resolveCheapest(
  items: CatalogItem[],
  shippingRules: ShippingRuleRepository,
  attributes: AttributesRepository,
  exchangeRates: ExchangeRateRepository,
  marketplaceConfig: MarketplaceConfig,
): Promise<ItemsWithMinimumPrice[]> {
  const marketplace = marketplaceConfig.getActive();

  const skus = [...new Set(items.map(i => i.sku))];
  const attrsMap = await attributes.getAttributesBatch(skus);

  const cheapestBySku = new Map<string, ItemsWithMinimumPrice>();

  for (const item of items) {
    if (item.stock <= 0) continue;

    const attrs = attrsMap.get(item.sku);
    if (!attrs) continue;

    const rule = await shippingRules.getRule(item.supplierId, marketplace.marketplaceCode);
    if (!rule) continue;

    if(!rule.enabled) continue;

    const supplierToMarketplace = rule.currency === marketplace.currencyCode
      ? 1
      : await exchangeRates.getRate(rule.currency, marketplace.currencyCode);

    const finalPrice = computeFinalPrice(item.cost, supplierToMarketplace, attrs, rule, marketplace);

    const current = cheapestBySku.get(item.sku);
    if (!current || finalPrice < current.minimumPrice) {
      cheapestBySku.set(item.sku, { item, minimumPrice: finalPrice });
    }
  }

  return [...cheapestBySku.values()];
}
