import type { FtpServiceConfig } from '../../../shared/ports.js';

export const WORTMANN_EUR_CONFIG: FtpServiceConfig = {
  host:     process.env.WORTMANN_EUR_FTP_HOST || '',
  user:     process.env.WORTMANN_EUR_FTP_USER || '',
  password: process.env.WORTMANN_EUR_FTP_PASSWORD || '',
  secure: false,
  verbose: false
};

export const WORTMANN_GBP_CONFIG: FtpServiceConfig = {
  host:     process.env.WORTMANN_GBP_FTP_HOST || '',
  user:     process.env.WORTMANN_GBP_FTP_USER || '',
  password: process.env.WORTMANN_GBP_FTP_PASSWORD || '',
  secure: false,
  verbose: false
};

export const WORTMANN_CONFIG = {
  PARTY_ID_EUR:   process.env.WORTMANN_ID_EUR || '',
  PARTY_ID_GBP:   process.env.WORTMANN_ID_GBP || '',
};

export type WortmannFtpRegion = 'EU' | 'UK';

export function wortmannPartyId(region: WortmannFtpRegion): string {
  return region === 'UK' ? WORTMANN_CONFIG.PARTY_ID_GBP : WORTMANN_CONFIG.PARTY_ID_EUR;
}
