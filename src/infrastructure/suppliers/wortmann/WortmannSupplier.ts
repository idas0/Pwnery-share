import * as fs from 'fs/promises';
import * as path from 'path';
import { Supplier } from '../../../domains/ordering/ports.js';
import {
  OrderRecord,
  ShippedOrderInfo,
  ShipToAddress,
  SupplierOrderLine,
  SupplierOrderResult,
} from '../../../domains/ordering/types.js';
import { CatalogItem } from '../../../domains/shared/types.js';
import type { FtpService } from '../../../shared/ports.js';
import { wortmannPartyId } from './config.js';
import { buildWortmannOrderXml } from './orderXml.js';
import { parseWortmannDeliveryNoteXml } from './deliveryNoteXml.js';
import logger from '../../../shared/logger.js';

const log = logger.child({ module: 'WortmannSupplier' });
const flow = 'supplier_wortmann';

const wortmannRemoteOutgoingPath    = '/outgoing';
const wortmannShipmentsTmpDir       = path.join('tmp', 'wortmann_shipments');
const wortmannShipmentsArchiveDir   = path.join('archive', 'wortmann_shipments');

export class WortmannSupplier implements Supplier {
  readonly supplierId = '3136';

  constructor(
    private readonly ftpEu: FtpService,
    private readonly ftpUk: FtpService,
  ) {}

  async getNewlyShippedOrders(uploadedOrders: OrderRecord[]): Promise<ShippedOrderInfo[]> {
    const startedAt = Date.now();
    const ordersForSupplier = uploadedOrders.filter((o) => o.supplierId === this.supplierId);
    if (ordersForSupplier.length === 0) {
      log.info({ flow, event: 'shipment_poll_complete', supplierId: this.supplierId,
        uploadedOrders: uploadedOrders.length,
        supplierOrders: 0,
        mappedShipments: 0,
        durationMs: Date.now() - startedAt,
      }, 'event=shipment_poll_complete no uploaded orders for Wortmann shipment poll');
      return [];
    }

    const ordersById   = new Map(ordersForSupplier.map((o) => [o.orderId, o]));
    const seenOrderIds = new Set<string>();
    const shipments: ShippedOrderInfo[] = [];
    log.info({ flow, event: 'shipment_poll_start', supplierId: this.supplierId,
      uploadedOrders: uploadedOrders.length,
      supplierOrders: ordersForSupplier.length,
    }, 'event=shipment_poll_start starting Wortmann shipment poll');

    await this.syncOutgoingDeliveryNotes(this.ftpEu, ordersById, seenOrderIds, shipments);
    await this.syncOutgoingDeliveryNotes(this.ftpUk, ordersById, seenOrderIds, shipments);

    log.info({ flow, event: 'shipment_poll_complete', supplierId: this.supplierId,
      supplierOrders: ordersForSupplier.length,
      mappedShipments: shipments.length,
      durationMs: Date.now() - startedAt,
    }, 'event=shipment_poll_complete completed Wortmann shipment poll');
    return shipments;
  }

  private async syncOutgoingDeliveryNotes(
    ftp: FtpService,
    ordersById: Map<string, OrderRecord>,
    seenOrderIds: Set<string>,
    shipments: ShippedOrderInfo[],
  ): Promise<void> {
    await fs.mkdir(wortmannShipmentsTmpDir, { recursive: true });
    await fs.mkdir(wortmannShipmentsArchiveDir, { recursive: true });

    let remoteFileNames: string[];
    const listStartedAt = Date.now();
    try {
      remoteFileNames = await ftp.listFiles(wortmannRemoteOutgoingPath);
      log.info({ flow, event: 'shipment_poll_remote_list', supplierId: this.supplierId,
        remotePath: wortmannRemoteOutgoingPath,
        remoteFiles: remoteFileNames.length,
        durationMs: Date.now() - listStartedAt,
      }, 'event=shipment_poll_remote_list listed remote shipment files');
    } catch (err) {
      log.error({ flow, event: 'shipment_poll_remote_list_failed', supplierId: this.supplierId, err,
        remotePath: wortmannRemoteOutgoingPath,
      }, 'event=shipment_poll_remote_list_failed failed to list remote shipment files');
      return;
    }

    const deliveryNoteNames = remoteFileNames.filter(
      (n) => n.toLowerCase().startsWith('deliverynote_') && n.endsWith('.xml'),
    );

    for (const fileName of deliveryNoteNames) {
      const remotePath = path.posix.join(wortmannRemoteOutgoingPath, fileName);
      const uniqueFileName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}_${fileName}`;
      const localTmpPath     = path.join(wortmannShipmentsTmpDir, uniqueFileName);
      const localArchivePath = path.join(wortmannShipmentsArchiveDir, uniqueFileName);

      const startedAt = Date.now();
      try {
        await ftp.downloadToLocal(remotePath, localTmpPath);
        const xml  = await fs.readFile(localTmpPath, 'utf-8');
        const note = parseWortmannDeliveryNoteXml(xml, fileName);

        if (note && ordersById.has(note.orderId) && !seenOrderIds.has(note.orderId)) {
          const order = ordersById.get(note.orderId)!;
          if (order.items.length > 0) {
            seenOrderIds.add(note.orderId);
            shipments.push({
              orderId: note.orderId,
              tracking: {
                trackingNumber: note.trackingNumber,
                carrierCode:    note.carrierCode,
                carrierName:    note.carrierName,
                shipDate:       note.shipDate,
              },
              orderItems: order.items.map((i) => ({
                orderItemId: i.orderItemId,
                quantity:    i.quantity,
              })),
            });
            log.info({ flow, event: 'shipment_mapped', supplierId: this.supplierId,
              orderId: note.orderId,
              trackingNumber: note.trackingNumber,
              orderItemCount: order.items.length,
            }, 'event=shipment_mapped mapped Wortmann shipment');
          }
        }

        await fs.rename(localTmpPath, localArchivePath);
        await ftp.deleteFile(remotePath);
        log.info({ flow, event: 'shipment_file_processed', supplierId: this.supplierId,
          fileName,
          remotePath,
          durationMs: Date.now() - startedAt,
        }, 'event=shipment_file_processed processed Wortmann delivery note');
      } catch (err) {
        log.error({ flow, event: 'shipment_file_processing_failed', supplierId: this.supplierId, err,
          fileName,
          remotePath,
          durationMs: Date.now() - startedAt,
        }, 'event=shipment_file_processing_failed failed to process Wortmann delivery note');
      } finally {
        await fs.unlink(localTmpPath).catch(() => {});
      }
    }
  }

  async fetchStock(_activeSkus: Set<string>): Promise<CatalogItem[]> {
    throw new Error('WortmannSupplier: fetchStock not implemented');
  }

  async placeOrder(lines: SupplierOrderLine[], shipTo: ShipToAddress, orderId: string): Promise<SupplierOrderResult> {
    if (lines.length === 0) {
      throw new Error(`WortmannSupplier.placeOrder: no lines for order ${orderId}`);
    }

    const selectedPartyId = wortmannPartyId(shipTo.countryCode === 'GB' ? 'UK' : 'EU');
    if (!selectedPartyId) {
      throw new Error(
        `WortmannSupplier.placeOrder: set WORTMANN_ID_${
          shipTo.countryCode === 'GB' ? 'GBP' : 'EUR'
        } for country ${shipTo.countryCode}`,
      );
    }

    const currency = shipTo.countryCode === 'GB' ? 'GBP' : 'EUR';
    const xmlFilename = `order_${orderId}.xml`;
    const localPath = path.join('tmp', xmlFilename);
    const startedAt = Date.now();
    log.info({ flow, event: 'place_order_attempt', supplierId: this.supplierId,
      orderId,
      countryCode: shipTo.countryCode,
      lineCount: lines.length,
    }, 'event=place_order_attempt placing Wortmann order');

    await fs.mkdir(path.dirname(localPath), { recursive: true });

    const xmlLines = lines.map((l) => ({
      sku:      l.supplierSku,
      quantity: l.quantity,
      price:    l.unitCost,
    }));

    const customerPayload = {
      name:        shipTo.name,
      companyName: shipTo.companyName ?? '',
      address:     shipTo.addressLine2
        ? `${shipTo.addressLine1} ${shipTo.addressLine2}`
        : shipTo.addressLine1,
      zip:     shipTo.postalCode,
      city:    shipTo.city,
      country: shipTo.countryCode,
      phone:   shipTo.phone ?? '',
    };

    const xml = buildWortmannOrderXml(orderId, currency, selectedPartyId, customerPayload, xmlLines);
    await fs.writeFile(localPath, xml, 'utf-8');
    const ftp = shipTo.countryCode === 'GB' ? this.ftpUk : this.ftpEu;
    await ftp.uploadFile(localPath, path.basename(localPath));

    log.info({ flow, event: 'place_order_result', supplierId: this.supplierId,
      orderId,
      countryCode: shipTo.countryCode,
      lineCount: lines.length,
      supplierOrderId: orderId,
      durationMs: Date.now() - startedAt,
    }, 'event=place_order_result Wortmann order XML uploaded');

    return { supplierOrderId: orderId };
  }

}
