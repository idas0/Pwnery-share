// ---------------------------------------------------------------------------
// Market data types — shared between pricing domain and infrastructure layer
// ---------------------------------------------------------------------------

export interface MoneyType {
  CurrencyCode: string;
  Amount: number;
}

export interface ListingOffer {
  MyOffer: boolean;
  IsBuyBoxWinner: boolean;
  IsFeaturedMerchant: boolean;
  IsFulfilledByAmazon: boolean;
  SellerId: string;
  SubCondition: string;
  ListingPrice: MoneyType;
  Shipping: MoneyType;
  ShippingTime: {
    minimumHours: number;
    maximumHours: number;
    availabilityType: string;
  };
  SellerFeedbackRating: {
    FeedbackCount: number;
    SellerPositiveFeedbackRating: number;
  };
  ShipsFrom: { Country: string };
  PrimeInformation?: { IsPrime: boolean; IsNationalPrime: boolean };
}

export interface B2BQuantityDiscountPrice {
  QuantityTier: number;
  QuantityDiscountType: 'QUANTITY_DISCOUNT';
  ListingPrice: { Amount: number; CurrencyCode: string };
}

export interface B2BOffer {
  SellerId: string;
  SubCondition: string;
  IsFulfilledByAmazon: boolean;
  IsFeaturedMerchant: boolean;
  IsBuyBoxWinner?: boolean;
  ListingPrice: { Amount: number; CurrencyCode: string };
  Shipping: { Amount: number; CurrencyCode: string };
  ShippingTime: { MinimumHours: number; MaximumHours: number; AvailabilityType: string };
  QuantityDiscountPrice?: B2BQuantityDiscountPrice[];
  PrimeInformation?: { IsPrime: boolean; IsNationalPrime: boolean };
}

export interface B2BMarketSnapshot {
  offers: B2BOffer[];
}

export interface MarketSnapshot {
  /** Filtered competitor offers (new, ≤8 days shipping, non-ignored sellers) */
  offers: ListingOffer[];
  /** Landed buy box price, or null if no buy box is active */
  buyBoxPrice: number | null;
  /** Whether we currently hold the buy box */
  weHaveBuyBox: boolean;
}

// ---------------------------------------------------------------------------
// Marketplace / cost types
// ---------------------------------------------------------------------------

export interface Marketplace {
  marketplaceCode: string;
  amazonMarketplaceId: string;
  currencyCode: string;
  vatFraction: number;
}

export interface ShippingRule {
  supplierId: string;
  marketplaceCode: string;
  enabled: boolean;
  currency: 'GBP' | 'EUR';
  flatShippingCostPerOrder: number;
  startWeightForPerKgFeeKg: number;
  shippingCostPerKg: number;
  oversizeOverweightSurcharge: number;
  hazardousSurcharge: number;
}

export interface ItemAttributes {
  sku: string;
  weightKg: number;
  isOversize: boolean;
  isHazardous: boolean;
  referralFeeFirstHundred: number;
  referralFeeRemaining: number;
}
