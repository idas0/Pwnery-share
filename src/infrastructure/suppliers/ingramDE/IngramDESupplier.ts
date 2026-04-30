import { randomUUID } from 'crypto';
import { Supplier } from '../../../domains/ordering/ports.js';
import { CatalogItem } from '../../../domains/shared/types.js';
import {
  OrderRecord,
  ShipmentStatus,
  ShippedOrderInfo,
  ShipToAddress,
  SupplierOrderLine,
  SupplierOrderResult,
} from '../../../domains/ordering/types.js';
import { normaliseCarrier } from '../../../domains/ordering/carrier.js';
import logger from '../../../shared/logger.js';

interface IngramOrderCreateResponse {
  ingramOrderNumber?: string;
  orderStatus?: string;
}

interface IngramPriceAndAvailabilityItem {
  productStatusCode?: string;
  productStatusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  index?: number;
  vendorPartNumber?: string;
  ingramPartNumber?: string;
  availability?: {
    totalAvailability?: number;
    availabilityByWarehouse?: Array<{
      quantityAvailable?: number;
    }>;
  };
  pricing?: {
    customerPrice?: number;
  };
}

interface IngramShipmentDetail {
  trackingNumber?: string;
  carrierCode?: string;
  carrierName?: string;
  shipDate?: string;
}

interface IngramOrderLine {
  shipmentDetails?: IngramShipmentDetail[];
}

interface IngramOrderDetailResponse {
  orderStatus?: string;
  lines?: IngramOrderLine[];
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface IngramRequestMeta {
  correlationId: string;
  countryCode: string;
  statusCode: number;
  rateLimitLimit: string | null;
  rateLimitRemaining: string | null;
  rateLimitReset: string | null;
}

const INGRAM_PRICE_AND_AVAILABILITY_BATCH_SIZE = 50;
const INGRAM_MAX_RETRIES_DEFAULT = 5;
const INGRAM_RETRY_BASE_MS_DEFAULT = 500;
const INGRAM_RETRY_MAX_MS_DEFAULT = 30000;
const INGRAM_RATE_LIMIT_BUFFER_MS_DEFAULT = 1000;
const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const flow = 'supplier_ingram';

export class IngramDESupplier implements Supplier {
  readonly supplierId = '-10';

  private readonly log = logger.child({ module: 'IngramDESupplier' });
  private readonly clientId = process.env.INGRAM_CLIENT_ID ?? '';
  private readonly clientSecret = process.env.INGRAM_CLIENT_SECRET ?? '';
  private readonly customerNumber = process.env.INGRAM_CUSTOMER_NUMBER ?? '';
  private readonly senderIdHeader = process.env.INGRAM_SENDER_ID ?? 'Pwnery';
  private readonly basePath = (process.env.INGRAM_BASE_URL ?? 'https://api.ingrammicro.com:443').replace(/\/+$/, '');
  private readonly stockCountry = 'DE';
  private readonly maxRetries = INGRAM_MAX_RETRIES_DEFAULT;
  private readonly retryBaseMs = INGRAM_RETRY_BASE_MS_DEFAULT;
  private readonly retryMaxMs = INGRAM_RETRY_MAX_MS_DEFAULT;
  private readonly rateLimitBufferMs = INGRAM_RATE_LIMIT_BUFFER_MS_DEFAULT;
  private tokenCache: TokenCache | null = null;

  async getNewlyShippedOrders(uploadedOrders: OrderRecord[]): Promise<ShippedOrderInfo[]> {
    const startedAt = Date.now();
    const orders = uploadedOrders.filter((order) => order.supplierId === this.supplierId);
    const shipments: ShippedOrderInfo[] = [];
    this.log.info({ flow, event: 'shipment_poll_start', supplierId: this.supplierId,
      uploadedOrders: uploadedOrders.length,
      supplierOrders: orders.length,
    }, 'event=shipment_poll_start starting Ingram shipment poll');

    for (const order of orders) {
      if (!order.supplierOrderId || order.items.length === 0) {
        this.log.debug({ flow, event: 'shipment_order_skipped', supplierId: this.supplierId,
          orderId: order.orderId,
          supplierOrderId: order.supplierOrderId ?? null,
          itemCount: order.items.length,
          reason: !order.supplierOrderId ? 'missing_supplier_order_id' : 'empty_items',
        }, 'event=shipment_order_skipped skipping order without supplierOrderId/items');
        continue;
      }

      let detail: IngramOrderDetailResponse;
      const detailStartedAt = Date.now();
      try {
        detail = await this.getOrderDetail(order.supplierOrderId);
        this.log.debug({ flow, event: 'shipment_order_detail_result', supplierId: this.supplierId,
          orderId: order.orderId,
          supplierOrderId: order.supplierOrderId,
          status: detail.orderStatus ?? null,
          durationMs: Date.now() - detailStartedAt,
        }, 'event=shipment_order_detail_result fetched Ingram order detail');
      } catch (err) {
        this.log.error({ flow, event: 'shipment_order_detail_failed', supplierId: this.supplierId, err,
          orderId: order.orderId,
          supplierOrderId: order.supplierOrderId,
          durationMs: Date.now() - detailStartedAt,
        }, 'event=shipment_order_detail_failed failed to fetch Ingram order detail');
        continue;
      }

      const shipment = this.extractShipment(detail);
      if (!shipment) {
        this.log.debug({ flow, event: 'shipment_order_skipped', supplierId: this.supplierId,
          orderId: order.orderId,
          supplierOrderId: order.supplierOrderId,
          reason: 'shipment_not_ready',
        }, 'event=shipment_order_skipped no shipment info found in Ingram detail');
        continue;
      }

      const orderItems = order.items
        .map((item) => ({ orderItemId: item.orderItemId, quantity: item.quantity }))
        .filter((item) => item.orderItemId && item.quantity > 0);
      if (orderItems.length === 0) {
        this.log.debug({ flow, event: 'shipment_order_skipped', supplierId: this.supplierId,
          orderId: order.orderId,
          supplierOrderId: order.supplierOrderId,
          reason: 'empty_order_items',
        }, 'event=shipment_order_skipped no valid order items for shipment confirmation');
        continue;
      }

      shipments.push({
        orderId: order.orderId,
        tracking: shipment,
        orderItems,
      });
      this.log.debug({ flow, event: 'shipment_mapped', supplierId: this.supplierId,
        orderId: order.orderId,
        supplierOrderId: order.supplierOrderId,
        trackingNumber: shipment.trackingNumber,
        orderItemCount: orderItems.length,
      }, 'event=shipment_mapped mapped shipment from Ingram detail');
    }

    this.log.info({ flow, event: 'shipment_poll_complete', supplierId: this.supplierId,
      supplierOrders: orders.length,
      mappedShipments: shipments.length,
      durationMs: Date.now() - startedAt,
    }, 'event=shipment_poll_complete completed Ingram shipment poll');
    return shipments;
  }

  async fetchStock(activeSkus: Set<string>): Promise<CatalogItem[]> {
    const startedAt = Date.now();
    const skus = [...activeSkus];
    if (skus.length === 0) {
      this.log.info({ flow, event: 'stock_fetch_complete', supplierId: this.supplierId,
        requestedSkus: 0,
        returnedItems: 0,
        durationMs: Date.now() - startedAt,
      }, 'event=stock_fetch_complete no active SKUs for Ingram stock fetch');
      return [];
    }

    const items: CatalogItem[] = [];
    const batchCount = Math.ceil(skus.length / INGRAM_PRICE_AND_AVAILABILITY_BATCH_SIZE);
    let totalErrorCount = 0;
    let totalRecords = 0;
    this.log.info({ flow, event: 'stock_fetch_start', supplierId: this.supplierId, requestedSkus: skus.length }, 'event=stock_fetch_start starting Ingram stock fetch');

    for (let index = 0; index < skus.length; index += INGRAM_PRICE_AND_AVAILABILITY_BATCH_SIZE) {
      const batch = skus.slice(index, index + INGRAM_PRICE_AND_AVAILABILITY_BATCH_SIZE);
      const batchStartedAt = Date.now();
      const batchNumber = Math.floor(index / INGRAM_PRICE_AND_AVAILABILITY_BATCH_SIZE) + 1;
      const matchedBefore = items.length;
      const { data: response, meta } = await this.ingramRequestWithMeta<IngramPriceAndAvailabilityItem[]>(
        'POST',
        '/resellers/v6/catalog/priceandavailability?includeAvailability=true&includePricing=true',
        this.stockCountry,
        {
          products: batch.map((sku) => ({ vendorPartNumber: sku })),
        },
      );
      const batchErrorCount = response.reduce((count, item) => {
        const message = item.errorMessage ?? item.productStatusMessage;
        return count + ((message || item.productStatusCode === 'E') ? 1 : 0);
      }, 0);
      totalErrorCount += batchErrorCount;
      totalRecords += response.length;

      for (const item of response) {
        const sku = item.vendorPartNumber?.trim();
        const supplierSku = item.ingramPartNumber?.trim();
        const stockFromTotal = item.availability?.totalAvailability;
        const stockFromWarehouses = (item.availability?.availabilityByWarehouse ?? [])
          .reduce((sum, warehouse) => sum + (warehouse.quantityAvailable ?? 0), 0);
        const stock = stockFromTotal ?? stockFromWarehouses;
        const cost = item.pricing?.customerPrice;

        if (!sku) {
          continue;
        }
        if (!activeSkus.has(sku)) {
          continue;
        }
        if (!supplierSku) {
          continue;
        }
        if (stockFromTotal == null && stockFromWarehouses === 0) {
          continue;
        }
        if (stock <= 0) {
          continue;
        }
        if (cost == null || cost <= 0) {
          continue;
        }

        items.push({
          sku,
          supplierId: this.supplierId,
          supplierSku,
          stock,
          cost,
        });
      }

      this.log.info({
        flow,
        event: 'stock_fetch_progress',
        supplierId: this.supplierId,
        batchNumber,
        batchCount,
        processedSkus: Math.min(index + batch.length, skus.length),
        requestedSkus: skus.length,
        returnedRecords: response.length,
        matchedItemsInBatch: items.length - matchedBefore,
        matchedItemsTotal: items.length,
        batchErrorCount,
        totalErrorCount,
        httpStatusCode: meta.statusCode,
        rateLimitRemaining: meta.rateLimitRemaining,
        durationMs: Date.now() - batchStartedAt,
      }, 'event=stock_fetch_progress Ingram stock fetch progress');
    }

    this.log.info({ flow, event: 'stock_fetch_complete', supplierId: this.supplierId,
      requestedSkus: skus.length,
      returnedRecords: totalRecords,
      totalErrorCount,
      returnedItems: items.length,
      durationMs: Date.now() - startedAt,
    }, 'event=stock_fetch_complete completed Ingram stock fetch');
    return items;
  }

  async placeOrder(lines: SupplierOrderLine[], shipTo: ShipToAddress, orderId: string): Promise<SupplierOrderResult> {
    if (lines.length === 0) {
      throw new Error(`IngramDESupplier.placeOrder: no lines for order ${orderId}`);
    }

    const startedAt = Date.now();
    this.log.info({ flow, event: 'place_order_attempt', supplierId: this.supplierId,
      orderId,
      lineCount: lines.length,
      countryCode: shipTo.countryCode,
    }, 'event=place_order_attempt placing Ingram order');
    const result = await this.createOrder(orderId, shipTo, lines);
    if (!result.ingramOrderNumber) {
      throw new Error(`IngramDESupplier.placeOrder: no Ingram order number returned for ${orderId}`);
    }

    this.log.info({ flow, event: 'place_order_result', supplierId: this.supplierId,
      orderId,
      supplierOrderId: result.ingramOrderNumber,
      status: result.orderStatus ?? null,
      durationMs: Date.now() - startedAt,
    }, 'event=place_order_result Ingram order created');
    return { supplierOrderId: result.ingramOrderNumber };
  }

  private buildUrl(endpointPath: string): string {
    return `${this.basePath}${endpointPath}`;
  }

  private correlationId(): string {
    return randomUUID();
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    if (!text) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  private async ingramRequest<T>(
    method: 'GET' | 'POST',
    endpointPath: string,
    countryCode: string,
    body?: unknown,
  ): Promise<T> {
    const { data } = await this.ingramRequestWithMeta<T>(method, endpointPath, countryCode, body);
    return data;
  }

  private async ingramRequestWithMeta<T>(
    method: 'GET' | 'POST',
    endpointPath: string,
    countryCode: string,
    body?: unknown,
  ): Promise<{ data: T; meta: IngramRequestMeta }> {
    const token = await this.getToken();
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const correlationId = this.correlationId();
      const startedAt = Date.now();
      try {
        const response = await fetch(this.buildUrl(endpointPath), {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'IM-CustomerNumber': this.customerNumber,
            'IM-CountryCode': countryCode,
            'IM-CorrelationID': correlationId,
            'IM-SenderID': this.senderIdHeader,
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        const meta: IngramRequestMeta = {
          correlationId,
          countryCode,
          statusCode: response.status,
          rateLimitLimit: response.headers.get('X-RateLimit-Limit'),
          rateLimitRemaining: response.headers.get('X-RateLimit-Remaining'),
          rateLimitReset: response.headers.get('X-RateLimit-Reset'),
        };
        if (RETRYABLE_HTTP_STATUS_CODES.has(response.status)) {
          const text = await response.text();
          const waitMs = response.status === 429
            ? this.getRetryAfterWaitMs(response.headers.get('Retry-After')) ?? this.getRateLimitWaitMs(meta.rateLimitReset) ?? this.getRetryDelayMs(attempt)
            : this.getRetryAfterWaitMs(response.headers.get('Retry-After')) ?? this.getRetryDelayMs(attempt);
          const err = new Error(`HTTP ${response.status}: ${text || response.statusText}`);
          if (attempt >= maxAttempts) {
            throw err;
          }
          this.log.warn({
            flow,
            event: 'request_retry_scheduled',
            supplierId: this.supplierId,
            method,
            endpointPath,
            correlationId,
            countryCode,
            statusCode: response.status,
            attempt,
            maxAttempts,
            waitMs,
            reason: response.status === 429 ? 'rate_limited' : 'retryable_http_status',
            rateLimitLimit: meta.rateLimitLimit,
            rateLimitRemaining: meta.rateLimitRemaining,
            rateLimitReset: meta.rateLimitReset,
            durationMs: Date.now() - startedAt,
          }, 'event=request_retry_scheduled retry scheduled after retryable HTTP status');
          await this.sleep(waitMs);
          continue;
        }

        const parsed = await this.parseResponse<T>(response);
        this.log.debug({ flow, event: 'request_result', supplierId: this.supplierId,
          method,
          endpointPath,
          correlationId,
          countryCode,
          statusCode: response.status,
          rateLimitLimit: meta.rateLimitLimit,
          rateLimitRemaining: meta.rateLimitRemaining,
          rateLimitReset: meta.rateLimitReset,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
        }, 'event=request_result Ingram API request completed');

        const throttleWaitMs = this.getProactiveThrottleWaitMs(meta.rateLimitRemaining, meta.rateLimitReset);
        if (throttleWaitMs > 0) {
          this.log.debug({
            flow,
            event: 'request_throttled',
            supplierId: this.supplierId,
            method,
            endpointPath,
            correlationId,
            countryCode,
            waitMs: throttleWaitMs,
            rateLimitRemaining: meta.rateLimitRemaining,
            rateLimitReset: meta.rateLimitReset,
          }, 'event=request_throttled pausing request flow to avoid rate limit');
          await this.sleep(throttleWaitMs);
        }

        return { data: parsed, meta };
      } catch (err) {
        const waitMs = this.getRetryDelayMs(attempt);
        if (attempt < maxAttempts && this.isRetryableTransportError(err)) {
          this.log.warn({
            flow,
            event: 'request_retry_scheduled',
            supplierId: this.supplierId,
            err,
            method,
            endpointPath,
            correlationId,
            countryCode,
            attempt,
            maxAttempts,
            waitMs,
            reason: 'transport_error',
            durationMs: Date.now() - startedAt,
          }, 'event=request_retry_scheduled retry scheduled after transport error');
          await this.sleep(waitMs);
          continue;
        }
        this.log.error({ flow, event: 'request_failed', supplierId: this.supplierId, err,
          method,
          endpointPath,
          correlationId,
          countryCode,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
        }, 'event=request_failed Ingram API request failed');
        throw err;
      }
    }

    throw new Error('Ingram request failed after retry exhaustion');
  }

  private getRetryDelayMs(attempt: number): number {
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(attempt - 1, 0));
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(this.retryBaseMs / 2)));
    return Math.min(this.retryMaxMs, exponential + jitter);
  }

  private getRateLimitWaitMs(rateLimitResetHeader: string | null): number | null {
    if (!rateLimitResetHeader) return null;
    const resetWaitTimeMs = Number(rateLimitResetHeader);
    if (!Number.isFinite(resetWaitTimeMs) || resetWaitTimeMs <= 0) return null;
    const waitMs = resetWaitTimeMs - Date.now() + this.rateLimitBufferMs;
    return Math.max(waitMs, this.rateLimitBufferMs);
  }

  private getRetryAfterWaitMs(retryAfterHeader: string | null): number | null {
    if (!retryAfterHeader) return null;
    const deltaSeconds = Number(retryAfterHeader);
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      return Math.max(Math.floor(deltaSeconds * 1000), this.rateLimitBufferMs);
    }
    const retryAtMs = Date.parse(retryAfterHeader);
    if (!Number.isFinite(retryAtMs)) return null;
    return Math.max(retryAtMs - Date.now(), this.rateLimitBufferMs);
  }

  private getProactiveThrottleWaitMs(rateLimitRemainingHeader: string | null, rateLimitResetHeader: string | null): number {
    if (!rateLimitRemainingHeader) return 0;
    const remaining = Number(rateLimitRemainingHeader);
    if (!Number.isFinite(remaining) || remaining > 2) return 0;
    return this.getRateLimitWaitMs(rateLimitResetHeader) ?? 0;
  }

  private isRetryableTransportError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const causeCode = typeof cause?.code === 'string' ? cause.code : null;
    if (causeCode && RETRYABLE_NETWORK_ERROR_CODES.has(causeCode)) return true;
    const ownCode = (err as { code?: unknown }).code;
    if (typeof ownCode === 'string' && RETRYABLE_NETWORK_ERROR_CODES.has(ownCode)) return true;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token;
    }

    const tokenUrl = new URL(this.buildUrl('/oauth/oauth20/token'));
    tokenUrl.searchParams.set('grant_type', 'client_credentials');
    tokenUrl.searchParams.set('client_id', this.clientId);
    tokenUrl.searchParams.set('client_secret', this.clientSecret);

    const response = await fetch(tokenUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = await this.parseResponse<{ access_token: string; expires_in: number }>(response);

    const expiresIn = data.expires_in ?? 3600;
    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + (expiresIn - 300) * 1000,
    };

    return this.tokenCache.token;
  }

  private async createOrder(
    orderId: string,
    shipTo: ShipToAddress,
    lines: SupplierOrderLine[],
  ): Promise<IngramOrderCreateResponse> {
    const orderRequest = {
      customerOrderNumber: orderId,
      shipToInfo: {
        contact: shipTo.name,
        companyName: shipTo.companyName ?? shipTo.name,
        addressLine1: shipTo.addressLine1,
        addressLine2: shipTo.addressLine2,
        city: shipTo.city,
        postalCode: shipTo.postalCode,
        countryCode: shipTo.countryCode,
        phoneNumber: shipTo.phone,
      },
      lines: lines.map((line, index) => ({
        customerLineNumber: String(index + 1),
        vendorPartNumber: line.brandSku,
        quantity: line.quantity,
        unitPrice: line.unitCost,
      })),
    };

    return this.ingramRequest<IngramOrderCreateResponse>(
      'POST',
      '/resellers/v6/orders',
      this.stockCountry,
      orderRequest,
    );
  }

  private async getOrderDetail(ingramOrderNumber: string): Promise<IngramOrderDetailResponse> {
    return this.ingramRequest<IngramOrderDetailResponse>(
      'GET',
      `/resellers/v6.1/orders/${encodeURIComponent(ingramOrderNumber)}`,
      this.stockCountry,
    );
  }

  private extractShipment(detail: IngramOrderDetailResponse): ShipmentStatus | null {
    for (const line of detail.lines ?? []) {
      for (const shipment of line.shipmentDetails ?? []) {
        if (!shipment.trackingNumber) continue;
        const normalised = normaliseCarrier(shipment.carrierCode, shipment.carrierName);
        return {
          trackingNumber: shipment.trackingNumber,
          carrierCode: normalised.carrierCode,
          carrierName: normalised.carrierName,
          shipDate: shipment.shipDate ?? new Date().toISOString().slice(0, 10),
        };
      }
    }
    return null;
  }

}