import { CatalogItem } from '../shared/types.js';
import {
  OrderDetails,
  OrderRecord,
  OrderStatus,
  ShipmentStatus,
  ShipToAddress,
  ShippedOrderInfo,
  SupplierOrderLine,
  SupplierOrderResult,
  UnshippedOrder,
} from './types.js';
import { MarketSnapshot } from '../pricing/types.js';

export interface ListingUpdate {
  sku: string;
  price?: number;
  currencyCode?: string;
  quantity?: number;
}

export interface Marketplace {
  getUnshippedOrders(): Promise<UnshippedOrder[]>;
  getOrderDetails(orderId: string): Promise<OrderDetails>;
  confirmShipment(orderId: string, tracking: ShipmentStatus, items: { orderItemId: string; quantity: number }[]): Promise<void>;
  getMarketSnapshot(sku: string): Promise<MarketSnapshot | null>;
  updateListingsBatch(updates: ListingUpdate[]): Promise<string>;
  updatePrice(sku: string, price: number, currencyCode: string): Promise<void>;
  updateB2BPrice(
    sku: string,
    singleUnitPrice: number,
    tierSchedule: { qty: number; price: number }[],
    currencyCode: string,
  ): Promise<string>;
}

export interface Supplier {
  readonly supplierId: string;
  fetchStock(activeSkus: Set<string>): Promise<CatalogItem[]>;
  placeOrder(lines: SupplierOrderLine[], shipTo: ShipToAddress, orderId: string): Promise<SupplierOrderResult>;
  getNewlyShippedOrders(uploadedOrders: OrderRecord[]): Promise<ShippedOrderInfo[]>;
}

export interface OrderStateRepository {
  get(orderId: string): Promise<OrderRecord | null>;
  upsertUploaded(orderId: string, data: Omit<OrderRecord, 'orderId' | 'status' | 'createdAt' | 'updatedAt' | 'failureReason' | 'retryCount' | 'deadlineAlerted'>): Promise<void>;
  upsertFailed(orderId: string, reason: string): Promise<void>;
  markShipped(orderId: string, tracking: ShipmentStatus): Promise<void>;
  markRetryPending(orderId: string, retryCount: number, reason: string): Promise<void>;
  markDeadlineAlerted(orderId: string): Promise<void>;

  getByStatus(status: OrderStatus): Promise<OrderRecord[]>;
  detectTimedOut(timeoutMinutes: number): Promise<string[]>;
}
