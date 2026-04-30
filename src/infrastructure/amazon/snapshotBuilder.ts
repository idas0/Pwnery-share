import { ListingOffer, MarketSnapshot, B2BOffer, B2BMarketSnapshot } from '../../domains/pricing/types.js';


interface NotificationMoneyType {
  Amount: number;
  CurrencyCode: string;
}

interface NotificationOffer {
  SellerId: string;
  SubCondition: string;
  IsFulfilledByAmazon: boolean;
  IsFeaturedMerchant: boolean;
  IsBuyBoxWinner?: boolean;
  ListingPrice: NotificationMoneyType;
  Shipping: NotificationMoneyType;
  ShippingTime: { MinimumHours: number; MaximumHours: number; AvailabilityType: string };
  SellerFeedbackRating?: { FeedbackCount: number; SellerPositiveFeedbackRating: number };
  ShipsFrom?: { Country: string };
  PrimeInformation?: { IsOfferPrime: boolean; IsOfferNationalPrime: boolean };
}

interface NotificationBuyBoxPrice {
  Condition: string;
  LandedPrice: NotificationMoneyType;
}

export interface AnyOfferChangedPayload {
  SellerId: string;
  OfferChangeTrigger: {
    MarketplaceId: string;
    ASIN: string;
    ItemCondition: string;
    TimeOfOfferChange: string;
  };
  Summary: {
    BuyBoxPrices?: NotificationBuyBoxPrice[];
  };
  Offers: NotificationOffer[];
}

export interface B2BAnyOfferChangedPayload {
  SellerId: string;
  OfferChangeTrigger: {
    MarketplaceId: string;
    ASIN: string;
    ItemCondition: string;
    TimeOfOfferChange: string;
  };
  Offers: B2BOffer[];
}

export interface SQSNotificationEnvelope {
  NotificationType: string;
  Payload: {
    AnyOfferChangedNotification?: AnyOfferChangedPayload;
    B2BAnyOfferChangedNotification?: B2BAnyOfferChangedPayload;
  };
}

export function buildB2BSnapshot(
  payload: B2BAnyOfferChangedPayload,
  ourSellerId: string,
): B2BMarketSnapshot {
  const offers: B2BOffer[] = payload.Offers.filter(o =>
    o.SellerId !== ourSellerId &&
    o.SubCondition.toLowerCase() === 'new',
  );
  return { offers };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function buildSnapshot(
  payload: AnyOfferChangedPayload,
  ourSellerId: string,
): MarketSnapshot {
  const ourOffer     = payload.Offers.find(o => o.SellerId === ourSellerId) ?? null;
  const weHaveBuyBox = ourOffer?.IsBuyBoxWinner === true;

  const offers: ListingOffer[] = payload.Offers
    .filter(o =>
      o.SellerId !== ourSellerId &&
      o.SubCondition.toLowerCase() === 'new',
    )
    .map(o => ({
      MyOffer:             false,
      IsBuyBoxWinner:      o.IsBuyBoxWinner ?? false,
      IsFeaturedMerchant:  o.IsFeaturedMerchant,
      IsFulfilledByAmazon: o.IsFulfilledByAmazon,
      SellerId:            o.SellerId,
      SubCondition:        o.SubCondition,
      ListingPrice:        o.ListingPrice,
      Shipping:            o.Shipping,
      ShippingTime: {
        minimumHours:     o.ShippingTime.MinimumHours,
        maximumHours:     o.ShippingTime.MaximumHours,
        availabilityType: o.ShippingTime.AvailabilityType,
      },
      SellerFeedbackRating: o.SellerFeedbackRating ?? { FeedbackCount: 0, SellerPositiveFeedbackRating: 0 },
      ShipsFrom:           o.ShipsFrom ?? { Country: '' },
      PrimeInformation:    o.PrimeInformation
        ? { IsPrime: o.PrimeInformation.IsOfferPrime, IsNationalPrime: o.PrimeInformation.IsOfferNationalPrime }
        : undefined,
    }));

  const buyBoxCompetitor = offers.find(o => o.IsBuyBoxWinner) ?? null;
  let buyBoxPrice: number | null = null;

  if (buyBoxCompetitor) {
    buyBoxPrice = round(buyBoxCompetitor.ListingPrice.Amount + buyBoxCompetitor.Shipping.Amount);
  } else {
    const newBuyBox = payload.Summary.BuyBoxPrices?.find(b => b.Condition.toLowerCase() === 'new');
    buyBoxPrice = newBuyBox ? round(newBuyBox.LandedPrice.Amount) : null;
  }

  return { offers, buyBoxPrice, weHaveBuyBox };
}
