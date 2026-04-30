import { getMarketplaceByCode } from '../../shared/config.js';
import { MarketplaceConfig } from '../../domains/pricing/ports.js';
import { Marketplace } from '../../domains/pricing/types.js';

export class ActiveMarketplaceConfig implements MarketplaceConfig {
  getActive(): Marketplace {
    const code = process.env.SP_API_MARKETPLACE_CODE;
    if (!code) throw new Error('SP_API_MARKETPLACE_CODE env var is required');
    const mp = getMarketplaceByCode(code);

    return {
      marketplaceCode:     mp.marketplaceCode,
      amazonMarketplaceId: mp.amazonMarketplaceId,
      currencyCode:        mp.currencyCode,
      vatFraction:         mp.vatFraction,
    };
  }
}
