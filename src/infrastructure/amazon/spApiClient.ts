import { SellingPartner } from 'amazon-sp-api';
import { Marketplace, ListingUpdate } from '../../domains/ordering/ports.js';
import { ListingOffer, MarketSnapshot } from '../../domains/pricing/types.js';
import {
  OrderDetails,
  PendingOrderItem,
  ShipmentStatus,
  ShipToAddress,
  UnshippedOrder,
} from '../../domains/ordering/types.js';
import logger from '../../shared/logger.js';
import { getMarketplaceByCode } from '../../shared/config.js';

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseAllowedSkus(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const values = raw
    .split(',')
    .map((sku) => sku.trim())
    .filter(Boolean);
  return values.length > 0 ? new Set(values) : null;
}

export class SpApiClient implements Marketplace {
  private readonly client: SellingPartner;
  private readonly marketplaceId: string;
  private readonly log = logger.child({ module: 'SpApiClient' });
  private readonly sellerId: string;
  private readonly allowedSkus: Set<string> | null;
  private readonly flow = 'infra_sp_api';

  constructor() {
    const region        = (process.env.SP_API_REGION ?? 'eu') as 'eu' | 'na' | 'fe';
    const clientId      = process.env.SP_API_CLIENT_ID;
    const clientSecret  = process.env.SP_API_CLIENT_SECRET;
    const refreshToken  = process.env.SP_API_REFRESH_TOKEN;
    const useSandbox    = process.env.SP_API_SANDBOX_ENABLED === 'true';
    const marketplaceCode = process.env.SP_API_MARKETPLACE_CODE;
    const sellerId      = process.env.SP_API_SELLER_ID;

    const missing = (
      ['SP_API_CLIENT_ID', 'SP_API_CLIENT_SECRET', 'SP_API_REFRESH_TOKEN', 'SP_API_MARKETPLACE_CODE', 'SP_API_SELLER_ID'] as const
    ).filter(k => !process.env[k]);

    if (missing.length > 0) {
      throw new Error(`SpApiClient: missing required env vars: ${missing.join(', ')}`);
    }

    const marketplace = getMarketplaceByCode(marketplaceCode!);
    this.marketplaceId = marketplace.amazonMarketplaceId;
    this.sellerId      = sellerId!;
    this.allowedSkus   = parseAllowedSkus(process.env.REPRICER_SKUS);

    this.client = new SellingPartner({
      region,
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID:     clientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
      },
      options: {
        use_sandbox: useSandbox,
      },
    });

    this.log.debug({ flow: this.flow, event: 'client_initialized', region, useSandbox }, 'event=client_initialized SP-API client initialised');
  }

  async getMarketSnapshot(sku: string): Promise<MarketSnapshot | null> {
    let response: any;
    try {
      response = await this.client.callAPI({
        operation: 'productPricing.getListingOffers',
        path: { SellerSKU: sku },
        query: { MarketplaceId: this.marketplaceId, ItemCondition: 'New' },
      });
    } catch (error: any) {
      this.log.warn({
        flow: this.flow,
        event: 'market_snapshot_fetch_failed',
        sku,
        error: error?.message ?? error,
      }, 'event=market_snapshot_fetch_failed failed to fetch market snapshot');
      return null;
    }

    const body = response?.payload ?? response;
    const rawOffers = Array.isArray(body?.Offers) ? body.Offers : [];

    const offers: ListingOffer[] = rawOffers
      .filter((offer: any) =>
        offer?.SellerId !== this.sellerId
        && String(offer?.SubCondition ?? '').toLowerCase() === 'new',
      )
      .map((offer: any) => ({
        MyOffer: false,
        IsBuyBoxWinner: offer?.IsBuyBoxWinner === true,
        IsFeaturedMerchant: offer?.IsFeaturedMerchant === true,
        IsFulfilledByAmazon: offer?.IsFulfilledByAmazon === true,
        SellerId: String(offer?.SellerId ?? ''),
        SubCondition: String(offer?.SubCondition ?? ''),
        ListingPrice: {
          CurrencyCode: String(offer?.ListingPrice?.CurrencyCode ?? 'GBP'),
          Amount: Number(offer?.ListingPrice?.Amount ?? 0),
        },
        Shipping: {
          CurrencyCode: String(offer?.Shipping?.CurrencyCode ?? 'GBP'),
          Amount: Number(offer?.Shipping?.Amount ?? 0),
        },
        ShippingTime: {
          minimumHours: Number(offer?.ShippingTime?.minimumHours ?? offer?.ShippingTime?.MinimumHours ?? 0),
          maximumHours: Number(offer?.ShippingTime?.maximumHours ?? offer?.ShippingTime?.MaximumHours ?? 0),
          availabilityType: String(offer?.ShippingTime?.availabilityType ?? offer?.ShippingTime?.AvailabilityType ?? ''),
        },
        SellerFeedbackRating: {
          FeedbackCount: Number(offer?.SellerFeedbackRating?.FeedbackCount ?? 0),
          SellerPositiveFeedbackRating: Number(offer?.SellerFeedbackRating?.SellerPositiveFeedbackRating ?? 0),
        },
        ShipsFrom: { Country: String(offer?.ShipsFrom?.Country ?? '') },
        PrimeInformation: offer?.PrimeInformation
          ? {
              IsPrime: offer.PrimeInformation.IsPrime ?? offer.PrimeInformation.IsOfferPrime ?? false,
              IsNationalPrime: offer.PrimeInformation.IsNationalPrime ?? offer.PrimeInformation.IsOfferNationalPrime ?? false,
            }
          : undefined,
      }));

    const rawBuyBoxPrices = Array.isArray(body?.Summary?.BuyBoxPrices) ? body.Summary.BuyBoxPrices : [];
    const summaryBuyBox = rawBuyBoxPrices.find((price: any) =>
      String(price?.Condition ?? '').toLowerCase() === 'new'
      && Number.isFinite(Number(price?.LandedPrice?.Amount)),
    );
    const buyBoxCompetitor = offers.find(offer => offer.IsBuyBoxWinner) ?? null;
    const buyBoxPrice = buyBoxCompetitor
      ? round(buyBoxCompetitor.ListingPrice.Amount + buyBoxCompetitor.Shipping.Amount)
      : summaryBuyBox
        ? round(Number(summaryBuyBox.LandedPrice.Amount))
        : null;

    const ourOffer = rawOffers.find((offer: any) =>
      offer?.MyOffer === true || String(offer?.SellerId ?? '') === this.sellerId,
    );

    return {
      offers,
      buyBoxPrice,
      weHaveBuyBox: ourOffer?.IsBuyBoxWinner === true,
    };
  }

  async updateListingsBatch(updates: ListingUpdate[]): Promise<string> {
    if (this.allowedSkus !== null) {
      const incomingUpdates = updates;
      updates = incomingUpdates.filter(u => this.allowedSkus!.has(u.sku));
      const blockedSkus = incomingUpdates
        .filter(u => !this.allowedSkus!.has(u.sku))
        .map(u => u.sku);

      this.log.info({
        flow: this.flow,
        event: 'listing_allowlist_applied',
        incomingSkuCount: incomingUpdates.length,
        allowedSkuCount: updates.length,
        blockedSkuCount: blockedSkus.length,
      }, 'event=listing_allowlist_applied listing update allowlist applied');
      if (blockedSkus.length > 0) {
        this.log.debug({ flow: this.flow, event: 'listing_allowlist_blocked_skus', blockedSkus }, 'event=listing_allowlist_blocked_skus blocked SKUs by allowlist');
      }

      if (updates.length === 0) {
        this.log.warn({ flow: this.flow, event: 'listing_allowlist_blocked_all', blockedSkuCount: blockedSkus.length }, 'event=listing_allowlist_blocked_all all listing updates blocked by allowlist');
        return 'blocked';
      }
    }
    if (updates.length === 0) {
      throw new Error('SpApiClient.updateListingsBatch: updates list is empty');
    }

    this.log.debug({
      flow: this.flow,
      event: 'listing_updates_payload',
      updates: updates.map(u => ({
        sku: u.sku,
        price: u.price ?? null,
        quantity: u.quantity ?? null,
      })),
    }, 'event=listing_updates_payload listing updates payload');

    type ListingsFeedPatch = {
      op: 'replace';
      path: string;
      value: Array<Record<string, unknown>>;
    };
    type ListingsFeedMessage = {
      messageId: number;
      sku: string;
      operationType: 'PATCH';
      productType: 'PRODUCT';
      patches: ListingsFeedPatch[];
    };

    const messages = updates
      .map((u, idx) => {
        const patches: ListingsFeedPatch[] = [];

        if (u.price != null) {
          patches.push({
            op: 'replace',
            path: '/attributes/purchasable_offer',
            value: [{
              marketplace_id: this.marketplaceId,
              currency: u.currencyCode ?? 'GBP',
              our_price: [{ schedule: [{ value_with_tax: u.price }] }],
            }],
          });
        }

        if (u.quantity != null) {
          patches.push({
            op: 'replace',
            path: '/attributes/fulfillment_availability',
            value: [{
              marketplace_id: this.marketplaceId,
              fulfillment_channel_code: 'DEFAULT',
              quantity: u.quantity,
            }],
          });
        }

        if (patches.length === 0) return null;

        return {
          messageId: idx + 1,
          sku: u.sku,
          operationType: 'PATCH',
          productType: 'PRODUCT',
          patches,
        };
      })
      .filter((m): m is ListingsFeedMessage => m !== null);

    if (messages.length === 0) {
      throw new Error('SpApiClient.updateListingsBatch: no valid price/quantity updates to send');
    }

    const feedContent = JSON.stringify({
      header: {
        sellerId: this.sellerId,
        version: '2.0',
        issueLocale: 'en_GB',
      },
      messages,
    });
    const contentType = 'application/json; charset=UTF-8';

    this.log.debug({
      flow: this.flow,
      event: 'listings_feed_submitting',
      skuCount: updates.length,
      messageCount: messages.length,
    }, 'event=listings_feed_submitting submitting JSON listings feed');

    const feedDocResp: any = await this.client.callAPI({
      operation: 'createFeedDocument',
      endpoint: 'feeds',
      body: { contentType },
    });
    const uploadDetails = feedDocResp.payload ?? feedDocResp;

    await this.client.upload(
      { url: uploadDetails.url },
      { content: feedContent, contentType },
    );

    const feedResult: any = await this.client.callAPI({
      operation: 'createFeed',
      endpoint: 'feeds',
      body: {
        feedType: 'JSON_LISTINGS_FEED',
        marketplaceIds: [this.marketplaceId],
        inputFeedDocumentId: uploadDetails.feedDocumentId,
      },
    });

    const feedId: string = feedResult.payload?.feedId ?? feedResult.feedId;

    this.log.info({ flow: this.flow, event: 'listings_feed_submitted', feedId, skuCount: updates.length }, 'event=listings_feed_submitted listings feed submitted');

    return feedId;
  }

  private isAllowed(sku: string): boolean {
    if (this.allowedSkus === null) return true;
    const allowed = this.allowedSkus.has(sku);
    if (!allowed) this.log.debug({ flow: this.flow, event: 'sku_blocked_by_allowlist', sku }, 'event=sku_blocked_by_allowlist SKU blocked by allowlist');
    return allowed;
  }

  async updateB2BPrice(
    sku: string,
    singleUnitPrice: number,
    tierSchedule: { qty: number; price: number }[],
    currencyCode: string,
  ): Promise<string> {
    if (!this.isAllowed(sku)) return 'blocked';
    const feedBody = JSON.stringify({
      header: { sellerId: this.sellerId, version: '2.0', issueLocale: 'en_GB' },
      messages: [{
        messageId: 1,
        sku,
        operationType: 'PATCH',
        productType: 'PRODUCT',
        patches: [{
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [{
            marketplace_id: this.marketplaceId,
            audience:       'B2B',
            currency:       currencyCode,
            our_price: [{ schedule: [{ value_with_tax: singleUnitPrice }] }],
            quantity_discount_plan: [{
              discount_type: 'fixed',
              levels: tierSchedule.map(tier => ({
                lower_bound:    tier.qty,
                value_with_tax: tier.price,
              })),
            }],
          }],
        }],
      }],
    });

    const contentType = 'application/json; charset=UTF-8';

    const feedDocResp: any = await this.client.callAPI({
      operation: 'createFeedDocument',
      endpoint:  'feeds',
      body:      { contentType },
    });
    const uploadDetails = feedDocResp.payload ?? feedDocResp;

    await this.client.upload({ url: uploadDetails.url }, { content: feedBody, contentType });

    const feedResult: any = await this.client.callAPI({
      operation: 'createFeed',
      endpoint:  'feeds',
      body: {
        feedType:            'JSON_LISTINGS_FEED',
        marketplaceIds:      [this.marketplaceId],
        inputFeedDocumentId: uploadDetails.feedDocumentId,
      },
    });

    const feedId: string = feedResult.payload?.feedId ?? feedResult.feedId;
    this.log.info({
      flow: this.flow,
      event: 'b2b_feed_submitted',
      sku,
      singleUnitPrice,
      tiersCount: tierSchedule.length,
      tierSchedule,
      feedId,
    }, 'event=b2b_feed_submitted B2B price feed submitted');
    return feedId;
  }

  async getUnshippedOrders(): Promise<UnshippedOrder[]> {
    const createdAfter = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const out: UnshippedOrder[] = [];
    let nextToken: string | undefined;

    do {
      const query: Record<string, string | string[]> =
        nextToken === undefined
          ? {
              MarketplaceIds: this.marketplaceId,
              CreatedAfter:   createdAfter,
              OrderStatuses:  ['Unshipped', 'PartiallyShipped'],
            }
          : { NextToken: nextToken };

      const response: { payload?: { Orders?: unknown[]; NextToken?: string }; Orders?: unknown[]; NextToken?: string } =
        await this.client.callAPI({
          operation: 'orders.getOrders',
          query,
        });

      const payload = response.payload ?? response;
      const batch = (payload as { Orders?: Array<{ AmazonOrderId?: string; LatestShipDate?: string }> }).Orders ?? [];

      for (const o of batch) {
        if (!o.AmazonOrderId) continue;
        out.push({
          orderId:        o.AmazonOrderId,
          latestShipDate: o.LatestShipDate,
        });
      }

      nextToken = (payload as { NextToken?: string }).NextToken;
    } while (nextToken);

    this.log.debug({ flow: this.flow, event: 'unshipped_orders_fetched', count: out.length }, 'event=unshipped_orders_fetched unshipped orders fetched');
    return out;
  }

  private extractShipTo(addressData: unknown): ShipToAddress | null {
    const addr = (addressData as { ShippingAddress?: Record<string, string | undefined> })?.ShippingAddress;
    if (!addr?.Name || !addr?.AddressLine1 || !addr?.PostalCode || !addr?.City || !addr?.CountryCode) return null;
    return {
      name:         addr.Name,
      companyName:  addr.BuyerCompanyName ?? undefined,
      addressLine1: addr.AddressLine1,
      addressLine2: addr.AddressLine2 ?? undefined,
      city:         addr.City,
      postalCode:   addr.PostalCode,
      countryCode:  addr.CountryCode,
      phone:        addr.Phone ?? undefined,
    };
  }

  //Might not get all items in an order, but that's intentional for now
  async getOrderDetails(orderId: string): Promise<OrderDetails> {
    const [itemsResp, addrResp] = await Promise.all([
      this.client.callAPI({ operation: 'orders.getOrderItems', path: { orderId } }),
      this.client.callAPI({ operation: 'orders.getOrderAddress', path: { orderId } }),
    ]);
    const ir = itemsResp as {
      OrderItems?: Array<Record<string, unknown>>;
      payload?: { OrderItems?: Array<Record<string, unknown>> };
    };
    const rows = ir.OrderItems ?? ir.payload?.OrderItems ?? [];
    if (rows.length === 0) throw new Error(`No items found for order ${orderId}`);

    const shipTo = this.extractShipTo((addrResp as { payload?: unknown }).payload ?? addrResp);
    if (!shipTo) throw new Error(`Incomplete shipping address for order ${orderId}`);

    const pendingItems: PendingOrderItem[] = [];
    for (const item of rows) {
      const qty =
        Number(item['QuantityOrdered'] ?? 0) - Number(item['QuantityShipped'] ?? 0);
      if (qty <= 0) continue;
      pendingItems.push({
        sku:         String(item['SellerSKU'] ?? ''),
        orderItemId: String(item['OrderItemId'] ?? ''),
        quantity:    qty,
      });
    }

    return { orderId, pendingItems, shipTo };
  }

  async confirmShipment(
    orderId: string,
    tracking: ShipmentStatus,
    items: { orderItemId: string; quantity: number }[],
  ): Promise<void> {
    if (items.length === 0) {
      throw new Error(`SpApiClient.confirmShipment: no items for order ${orderId}`);
    }

    const feedContent = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.02</DocumentVersion>
    <MerchantIdentifier>${this.sellerId}</MerchantIdentifier>
  </Header>
  <MessageType>OrderFulfillment</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <OrderFulfillment>
      <AmazonOrderID>${orderId}</AmazonOrderID>
      <FulfillmentDate>${tracking.shipDate}T00:00:00Z</FulfillmentDate>
      <FulfillmentData>
        <CarrierCode>${tracking.carrierCode}</CarrierCode>
        <CarrierName>${tracking.carrierName}</CarrierName>
        <ShippingMethod>Standard</ShippingMethod>
        <ShipperTrackingNumber>${tracking.trackingNumber}</ShipperTrackingNumber>
      </FulfillmentData>
${items
  .map(
    (item) => `      <Item>
        <AmazonOrderItemCode>${item.orderItemId}</AmazonOrderItemCode>
        <Quantity>${item.quantity}</Quantity>
      </Item>`,
  )
  .join('\n')}
    </OrderFulfillment>
  </Message>
</AmazonEnvelope>`;

    const contentType = 'text/xml; charset=utf-8';

    const feedDocResp: any = await this.client.callAPI({
      operation: 'createFeedDocument',
      endpoint: 'feeds',
      body: { contentType },
    });
    const uploadDetails = feedDocResp.payload ?? feedDocResp;

    await this.client.upload(
      { url: uploadDetails.url },
      { content: feedContent, contentType },
    );

    const feedResult: any = await this.client.callAPI({
      operation: 'createFeed',
      endpoint: 'feeds',
      body: {
        feedType:            'POST_ORDER_FULFILLMENT_DATA',
        marketplaceIds:      [this.marketplaceId],
        inputFeedDocumentId: uploadDetails.feedDocumentId,
      },
    });

    const feedId: string = feedResult.payload?.feedId ?? feedResult.feedId;
    this.log.info({
      flow: this.flow,
      event: 'fulfillment_feed_submitted',
      orderId,
      feedId,
      itemCount: items.length,
    }, 'event=fulfillment_feed_submitted order fulfillment feed submitted');
  }

  async updatePrice(sku: string, price: number, currencyCode: string): Promise<void> {
    if (!this.isAllowed(sku)) return;
    await this.client.callAPI({
      operation: 'listingsItems.patchListingsItem',
      path: { sellerId: this.sellerId, sku },
      query: { marketplaceIds: [this.marketplaceId] },
      body: {
        productType: 'PRODUCT',
        patches: [{
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [{
            marketplace_id: this.marketplaceId,
            currency:       currencyCode,
            our_price:      [{ schedule: [{ value_with_tax: price }] }],
          }],
        }],
      },
    });

    this.log.debug({
      flow: this.flow,
      event: 'price_updated',
      sku,
      price,
      currencyCode,
    }, 'event=price_updated price updated via Listings API');
  }
}
