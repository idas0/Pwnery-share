export interface Marketplace {
  marketplaceCode: string;
  marketplaceName: string;
  amazonMarketplaceId: string;
  currencyCode: string;
  vatFraction: number;
}

export interface Distributor {
  distributorId: number;
  distributorName: string;
}

export const MARKETPLACES: readonly Marketplace[] = [
  { marketplaceCode: 'UK', marketplaceName: 'United Kingdom', amazonMarketplaceId: 'A1F83G8C2ARO7P', currencyCode: 'GBP', vatFraction: 0.1667 },
  { marketplaceCode: 'DE', marketplaceName: 'Germany', amazonMarketplaceId: 'A1PA6795UKMFR9', currencyCode: 'EUR', vatFraction: 0.1597 },
  { marketplaceCode: 'FR', marketplaceName: 'France', amazonMarketplaceId: 'A13V1IB3VIYZZH', currencyCode: 'EUR', vatFraction: 0.1667 },
  { marketplaceCode: 'ES', marketplaceName: 'Spain', amazonMarketplaceId: 'A1RKKUPIHCS9HS', currencyCode: 'EUR', vatFraction: 0.1736 },
  { marketplaceCode: 'IT', marketplaceName: 'Italy', amazonMarketplaceId: 'APJ6JRA9NG5V4', currencyCode: 'EUR', vatFraction: 0.1803 },
  { marketplaceCode: 'NL', marketplaceName: 'Netherlands', amazonMarketplaceId: 'A1805IZSGTT6HS', currencyCode: 'EUR', vatFraction: 0.1736 },
  { marketplaceCode: 'BE', marketplaceName: 'Belgium', amazonMarketplaceId: 'AMEN7PMS3EDWL', currencyCode: 'EUR', vatFraction: 0.1736 },
  { marketplaceCode: 'PL', marketplaceName: 'Poland', amazonMarketplaceId: 'A1C3SOZRARQ6R3', currencyCode: 'PLN', vatFraction: 0.1870 },
  { marketplaceCode: 'SE', marketplaceName: 'Sweden', amazonMarketplaceId: 'A2NODRKZP88ZB9', currencyCode: 'SEK', vatFraction: 0.2000 },
] as const;

export const DISTRIBUTORS: readonly Distributor[] = [
  { distributorId: -10, distributorName: 'Ingram Micro DE' },
  { distributorId: 0, distributorName: 'LOC' },
  { distributorId: 1, distributorName: 'Ingram Micro' },
  { distributorId: 6, distributorName: 'Northamber' },
  { distributorId: 10, distributorName: 'TD Synnex UK' },
  { distributorId: 11, distributorName: 'Midwich' },
  { distributorId: 12, distributorName: 'Exertis IT' },
  { distributorId: 14, distributorName: 'Exertis Supplies' },
  { distributorId: 16, distributorName: 'CMS Distribution' },
  { distributorId: 27, distributorName: 'Mentor (UK)' },
  { distributorId: 28, distributorName: 'VIP' },
  { distributorId: 34, distributorName: 'Target Components' },
  { distributorId: 51, distributorName: 'EET' },
  { distributorId: 91, distributorName: 'Jarltech' },
  { distributorId: 1731, distributorName: 'Smithie UK' },
  { distributorId: 1973, distributorName: 'Foxway' },
  { distributorId: 2146, distributorName: 'Ikonic' },
  { distributorId: 3136, distributorName: 'Terra Computer' },
  { distributorId: 4603, distributorName: 'Intec Microsystems' },
  { distributorId: 5783, distributorName: 'Elmtec' },
  { distributorId: 6063, distributorName: 'Lindy Electronics' },
  { distributorId: 6095, distributorName: 'Caseking UK' },
  { distributorId: 7364, distributorName: 'Corptel' },
  { distributorId: 7548, distributorName: 'Travion IT Distribution' },
  { distributorId: 7975, distributorName: 'Servers Plus' },
  { distributorId: 8265, distributorName: 'Videnda Distribution' },
  { distributorId: 9353, distributorName: 'LinITX Wireless & Networking' },
  { distributorId: 10622, distributorName: 'Promo-Products' },
  { distributorId: 11092, distributorName: 'WERD' },
] as const;

export function getMarketplaceByCode(code: string): Marketplace {
  const normalized = code.trim().toUpperCase();
  const marketplace = MARKETPLACES.find((entry) => entry.marketplaceCode === normalized);
  if (!marketplace) {
    throw new Error(`Unknown marketplace code: ${code}`);
  }
  return marketplace;
}
