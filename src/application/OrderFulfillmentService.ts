import { Marketplace, Supplier, OrderStateRepository } from '../domains/ordering/ports.js';
import { Notifier } from '../shared/ports.js';
import { SupplierOrderLine, UnshippedOrder } from '../domains/ordering/types.js';
import { InventoryRepository } from '../domains/inventory/ports.js';
import logger from '../shared/logger.js';

const log = logger.child({ service: 'OrderFulfillmentService' });
const flow = 'order_fulfillment';

export class OrderFulfillmentService {
  constructor(
    private readonly marketplace:    Marketplace,
    private readonly orderStateRepo: OrderStateRepository,
    private readonly inventoryRepo:  InventoryRepository,
    private readonly suppliers:      Supplier[],
    private readonly notifier:       Notifier,
  ) {}

  async run(): Promise<void> {
    const runStartedAt = Date.now();
    await this.orderStateRepo.detectTimedOut(15);

    const unshipped    = await this.marketplace.getUnshippedOrders();
    const retryPending = await this.orderStateRepo.getByStatus('retry_pending');
    const unshippedOrderIds = unshipped.map((order) => order.orderId);
    const retryPendingOrderIds = retryPending.map((order) => order.orderId);

    const unshippedIds = new Set(unshipped.map(o => o.orderId));
    const missingRetries: UnshippedOrder[] = retryPending
      .filter(rp => !unshippedIds.has(rp.orderId))
      .map((rp): UnshippedOrder => ({ orderId: rp.orderId, latestShipDate: rp.latestShipDate }));
    const missingRetryOrderIds = missingRetries.map((order) => order.orderId);

    const ordersToProcess: UnshippedOrder[] = [...unshipped, ...missingRetries];
    const ordersToProcessOrderIds = ordersToProcess.map((order) => order.orderId);

    log.info({ flow, event: 'run_start' }, 'event=run_start worker run started');
    log.info({
      flow,
      event: 'orders_collected',
      unshippedCount: unshippedOrderIds.length,
      retryPendingCount: retryPendingOrderIds.length,
      missingRetryCount: missingRetryOrderIds.length,
      ordersToProcessCount: ordersToProcessOrderIds.length,
      unshippedOrderIds,
      retryPendingOrderIds,
      missingRetryOrderIds,
      ordersToProcessOrderIds,
    }, 'event=orders_collected collected orders for processing');

    for (const { orderId, latestShipDate } of ordersToProcess) {
      try {
        await this.processOrder(orderId, latestShipDate);
      } catch (err) {
        log.error({ flow, event: 'order_processing_error', err, orderId }, 'event=order_processing_error unexpected order processing failure');
      }
    }

    await this.confirmShipments();
    log.info({ flow, event: 'run_complete', durationMs: Date.now() - runStartedAt }, 'event=run_complete worker run completed');
  }

  private async processOrder(orderId: string, latestShipDate?: string): Promise<void> {
    log.info({ flow, event: 'order_process_start', orderId }, 'event=order_process_start processing order');
    const existing = await this.orderStateRepo.get(orderId);
    if (existing && existing.status !== 'retry_pending') {
      log.info({ flow, event: 'order_skipped',
        orderId,
        status: existing.status,
        reason: 'already_processed',
      }, 'event=order_skipped existing order is already in terminal/active state');
      return;
    }

    const orderDetails = await this.marketplace.getOrderDetails(orderId);
    if (orderDetails.pendingItems.length === 0) {
      log.info({ flow, event: 'order_skipped',
        orderId,
        reason: 'no_pending_items',
      }, 'event=order_skipped order has no pending items');
      return;
    }

    if (orderDetails.pendingItems.length > 1) {
      log.warn({ flow, event: 'order_decision',
        orderId,
        status: 'failed',
        reason: 'multi_sku',
        pendingItemsCount: orderDetails.pendingItems.length,
      }, 'event=order_decision multi-SKU order requires manual review');
      await this.notifier.send(
        `⚠️ Multi-SKU order requires manual review`,
        `Order **${orderId}** has ${orderDetails.pendingItems.length} items and cannot be auto-fulfilled.`,
        'warning',
      );
      await this.orderStateRepo.upsertFailed(orderId, 'Multi-SKU order requires manual review');
      return;
    }

    const item  = orderDetails.pendingItems[0];
    const stock = await this.inventoryRepo.getBySku(item.sku);

    if (!stock || stock.stock === 0) {
      log.warn({ flow, event: 'order_decision',
        orderId,
        sku: item.sku,
        status: 'failed',
        reason: stock ? 'out_of_stock' : 'missing_stock',
      }, 'event=order_decision order cannot be fulfilled due to stock state');
      await this.notifier.send(
        `⚠️ Order ${orderId} cannot be fulfilled`,
        `SKU \`${item.sku}\` is ${stock ? 'out of stock' : 'not found in inventory'}.`,
        'warning',
      );
      await this.orderStateRepo.upsertFailed(orderId, stock ? 'out of stock' : 'not found in inventory');
      return;
    }

    const quantityToOrder = Math.min(item.quantity, stock.stock);
    const partial = quantityToOrder < item.quantity;
    log.info({ flow, event: 'order_decision',
      orderId,
      sku: item.sku,
      supplierId: stock.supplierId,
      status: partial ? 'partial' : 'full',
      requestedQuantity: item.quantity,
      availableQuantity: stock.stock,
      orderedQuantity: quantityToOrder,
    }, 'event=order_decision prepared supplier order quantity');
    if (quantityToOrder < item.quantity) {
      await this.notifier.send(
        `⚠️ Partial fulfillment — manual review`,
        `Order **${orderId}**: SKU \`${item.sku}\` — ordered ${item.quantity}, only ${stock.stock} available. Placing supplier order for ${quantityToOrder}.`,
        'warning',
      );
      log.warn({ flow, event: 'order_partial',
        orderId,
        sku: item.sku,
        requestedQuantity: item.quantity,
        availableQuantity: stock.stock,
        orderedQuantity: quantityToOrder,
      }, 'event=order_partial partial fulfillment required');
    }

    const supplierId = stock.supplierId;
    const line: SupplierOrderLine = {
      brandSku:    item.sku,
      supplierSku: stock.supplierSku,
      quantity:    quantityToOrder,
      unitCost:    stock.cost,
      orderItemId: item.orderItemId,
    };
    const supplier = this.suppliers.find(s => s.supplierId === supplierId);
    if (!supplier) {
      log.error({ flow, event: 'order_decision',
        orderId,
        supplierId,
        status: 'failed',
        reason: 'supplier_not_registered',
      }, 'event=order_decision supplier not registered');
      await this.orderStateRepo.upsertFailed(orderId, `supplier ${supplierId} not registered`);
      return;
    }

    let supplierOrderId: string | undefined;
    let success = true;
    const supplierCallStartedAt = Date.now();
    log.info({ flow, event: 'supplier_place_order_attempt',
      orderId,
      supplierId,
      sku: item.sku,
      lineCount: 1,
    }, 'event=supplier_place_order_attempt placing supplier order');
    try {
      const result   = await supplier.placeOrder([line], orderDetails.shipTo, orderId);
      supplierOrderId = result.supplierOrderId;
      log.info({ flow, event: 'supplier_place_order_result',
        orderId,
        supplierId,
        supplierOrderId,
        status: 'success',
        durationMs: Date.now() - supplierCallStartedAt,
      }, 'event=supplier_place_order_result supplier order placed');
    } catch (err) {
      log.error({ flow, event: 'supplier_place_order_result', err,
        orderId,
        supplierId,
        status: 'failed',
        durationMs: Date.now() - supplierCallStartedAt,
      }, 'event=supplier_place_order_result supplier placeOrder failed');
      success = false;
    }

    if (success) {
      await this.orderStateRepo.upsertUploaded(orderId, {
        supplierId,
        supplierOrderId,
        customerName:    orderDetails.shipTo.name,
        customerCountry: orderDetails.shipTo.countryCode,
        items:           [line],
        ...(latestShipDate && { latestShipDate }),
      });
      log.info({ flow, event: 'order_state_upserted',
        orderId,
        supplierId,
        supplierOrderId,
        status: 'uploaded',
      }, 'event=order_state_upserted order marked uploaded');
      return;
    } else {
      const retryCount = (existing?.retryCount ?? 0) + 1;
      const MAX_RETRIES = 3;
      if (retryCount <= MAX_RETRIES) {
        await this.orderStateRepo.markRetryPending(orderId, retryCount, 'Supplier placeOrder failed');
        log.warn({ flow, event: 'order_retry_scheduled',
          orderId,
          supplierId,
          status: 'retry_pending',
          attempt: retryCount,
          maxRetries: MAX_RETRIES,
          reason: 'supplier_place_order_failed',
        }, 'event=order_retry_scheduled order queued for retry');
        return;
      } else {
        await this.orderStateRepo.upsertFailed(orderId, `Max retries (${MAX_RETRIES}) exceeded`);
        log.error({ flow, event: 'order_terminal_failure',
          orderId,
          supplierId,
          status: 'failed',
          attempt: retryCount,
          maxRetries: MAX_RETRIES,
          reason: 'max_retries_exceeded',
        }, 'event=order_terminal_failure order exceeded max retries');
        await this.notifier.send(
          `🚨 Order ${orderId} permanently failed`,
          `Order **${orderId}** failed after ${MAX_RETRIES} retries and requires manual intervention.`,
          'error',
        );
        return;
      }
    }
  }

  private async confirmShipments(): Promise<void> {
    const uploadedOrders = await this.orderStateRepo.getByStatus('uploaded');
    if (uploadedOrders.length === 0) return;
    const pollStartedAt = Date.now();

    log.info({ flow, event: 'shipment_poll_start' }, 'event=shipment_poll_start starting shipment confirmation poll');

    const results = await Promise.allSettled(
      this.suppliers.map(async (supplier) => {
        const supplierOrders = uploadedOrders.filter((o) => o.supplierId === supplier.supplierId);
        if (supplierOrders.length === 0) return;
        const pollStartedAt = Date.now();
        log.info({ flow, event: 'supplier_shipment_poll_attempt',
          supplierId: supplier.supplierId,
        }, 'event=supplier_shipment_poll_attempt polling supplier shipments');

        const shipments = await supplier.getNewlyShippedOrders(supplierOrders);
        log.info({ flow, event: 'supplier_shipment_poll_result',
          supplierId: supplier.supplierId,
          durationMs: Date.now() - pollStartedAt,
        }, 'event=supplier_shipment_poll_result supplier shipment poll completed');
        for (const shipment of shipments) {
          const confirmStartedAt = Date.now();
          try {
            await this.marketplace.confirmShipment(shipment.orderId, shipment.tracking, shipment.orderItems);
            await this.orderStateRepo.markShipped(shipment.orderId, shipment.tracking);
            log.info({ flow, event: 'shipment_confirmed',
              orderId: shipment.orderId,
              supplierId: supplier.supplierId,
              trackingNumber: shipment.tracking.trackingNumber,
              durationMs: Date.now() - confirmStartedAt,
            }, 'event=shipment_confirmed shipment confirmed and persisted');
          } catch (err) {
            log.error({ flow, event: 'shipment_confirmation_failed', err,
              orderId: shipment.orderId,
              supplierId: supplier.supplierId,
              trackingNumber: shipment.tracking.trackingNumber,
            }, 'event=shipment_confirmation_failed shipment confirmation failed');
          }
        }
      }),
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error({ flow, event: 'supplier_shipment_poll_failed', err: result.reason,
          supplierId: this.suppliers[index].supplierId,
        }, 'event=supplier_shipment_poll_failed supplier shipment poll failed');
      }
    });
    log.info({ flow, event: 'shipment_poll_complete',
      durationMs: Date.now() - pollStartedAt,
    }, 'event=shipment_poll_complete shipment confirmation poll completed');
  }
}
