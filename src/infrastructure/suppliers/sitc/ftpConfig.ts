import type { FtpServiceConfig } from '../../../shared/ports.js';

export const STOCK_FTP_CONFIG: FtpServiceConfig = {
  host: process.env.FTP_HOST || '',
  user: process.env.FTP_USER || '',
  password: process.env.FTP_PASSWORD || '',
  secure: false,
  verbose: false,
};

export const FTP_PATHS = {
  STOCK_FILE: process.env.FTP_PATH || 'DistributorStockAndPrices.csv',
};
