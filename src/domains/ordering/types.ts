export type OrderStatus = 'uploading' | 'uploaded' | 'shipped' | 'retry_pending' | 'failed';

export interface ShipToAddress {
  name: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
}

export interface PendingOrderItem {
  sku: string;
  orderItemId: string;
  quantity: number;
}

export interface SupplierOrderLine {
  brandSku: string;
  supplierSku: string;
  quantity: number;
  unitCost: number;
  orderItemId: string;
}

export interface SupplierOrderResult {
  supplierOrderId: string;
}

export interface ShipmentStatus {
  trackingNumber: string;
  carrierCode: string;
  carrierName: string;
  shipDate: string;
}

export interface ShippedOrderInfo {
  orderId: string;
  tracking: ShipmentStatus;
  orderItems: { orderItemId: string; quantity: number }[];
}

export interface UnshippedOrder {
  orderId: string;
  latestShipDate?: string;
}

export interface OrderDetails {
  orderId: string;
  pendingItems: PendingOrderItem[];
  shipTo: ShipToAddress;
}

export interface OrderRecord {
  orderId: string;
  marketplaceCode?: string;
  status: OrderStatus;
  supplierId?: string;
  supplierOrderId?: string;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  customerCountry: string;
  items: SupplierOrderLine[];
  latestShipDate?: string;
  deadlineAlerted?: boolean;
  failureReason?: string;
  retryCount?: number;
}
