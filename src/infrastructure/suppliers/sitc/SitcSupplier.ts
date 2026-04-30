import * as fs from 'fs/promises';
import * as path from 'path';
import type { FtpService } from '../../../shared/ports.js';
import { FTP_PATHS } from './ftpConfig.js';
import { parseStockData } from '../../../common/csvParser.js';
import { Supplier } from '../../../domains/ordering/ports.js';
import { SupplierOrderLine, ShipToAddress, SupplierOrderResult, ShippedOrderInfo, OrderRecord } from '../../../domains/ordering/types.js';
import { CatalogItem } from '../../../domains/shared/types.js';
import logger from '../../../shared/logger.js';

const LOCAL_CACHE_PATH = path.resolve('tmp', 'DistributorStockAndPrices.csv');
const flow = 'inventory_supplier_sitc';

export class SitcSupplierSource implements Supplier {
  readonly supplierId = 'sitc';
  private readonly log = logger.child({ module: 'SitcSupplierSource' });

  constructor(private readonly ftp: FtpService) {}

  async fetchStock(activeSkus: Set<string>): Promise<CatalogItem[]> {
    const csv = await this.downloadIfUpdated();
    const rows = parseStockData(csv).filter(r => activeSkus.has(r.SKU));

    this.log.debug({
      flow,
      event: 'stock_rows_filtered',
      supplierId: this.supplierId,
      rowCount: rows.length,
    }, 'event=stock_rows_filtered SITC stock rows filtered by active SKUs');

    return rows.map(r => ({
      sku: r.SKU,
      supplierId: r.DistributorID,
      supplierSku: r.DistributorSKU,
      stock: r.Stock,
      cost: r.Cost,
    }));
  }

  async placeOrder(_lines: SupplierOrderLine[], _shipTo: ShipToAddress, _orderId: string): Promise<SupplierOrderResult> {
    throw new Error('SITC is a stock aggregator — ordering not supported');
  }

  async getNewlyShippedOrders(_uploadedOrders: OrderRecord[]): Promise<ShippedOrderInfo[]> {
    throw new Error('SITC is a stock aggregator — ordering not supported');
  }

  private async downloadIfUpdated(): Promise<string> {
    const remoteModified = await this.ftp.getLastModified(FTP_PATHS.STOCK_FILE);

    let localModified: Date | null = null;
    try {
      localModified = (await fs.stat(LOCAL_CACHE_PATH)).mtime;
    } catch {}

    if (localModified && localModified >= remoteModified) {
      this.log.debug({
        flow,
        event: 'stock_cache_hit',
        supplierId: this.supplierId,
        remoteModified,
        localModified,
      }, 'event=stock_cache_hit SITC stock cache is up to date');
      return fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
    }

    this.log.info({
      flow,
      event: 'stock_download_start',
      supplierId: this.supplierId,
      remoteModified,
    }, 'event=stock_download_start downloading SITC stock file');
    await fs.mkdir(path.dirname(LOCAL_CACHE_PATH), { recursive: true });
    await this.ftp.downloadToLocal(FTP_PATHS.STOCK_FILE, LOCAL_CACHE_PATH);
    await fs.utimes(LOCAL_CACHE_PATH, remoteModified, remoteModified);

    return fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
  }
}
