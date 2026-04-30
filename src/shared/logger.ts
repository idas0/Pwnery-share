import pino from 'pino';

// const skuAllowlist = (() => {
//   const raw = process.env.REPRICER_SKUS?.trim();
//   if (!raw) return null;
//   const values = raw.split(',').map((sku) => sku.trim()).filter(Boolean);
//   return values.length > 0 ? new Set(values) : null;
// })();
//
// function extractSku(args: unknown[]): string | null {
//   for (const arg of args) {
//     if (arg && typeof arg === 'object' && 'sku' in (arg as Record<string, unknown>)) {
//       const sku = (arg as Record<string, unknown>)['sku'];
//       return typeof sku === 'string' && sku.length > 0 ? sku : null;
//     }
//   }
//   return null;
// }

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    if (process.env.SP_API_MARKETPLACE_CODE) {
      return { marketplaceCode: process.env.SP_API_MARKETPLACE_CODE };
    }
    return {};
  },
  // hooks: {
  //   logMethod(args, method) {
  //     if (skuAllowlist !== null) {
  //       const levelVal = (method as unknown as { levelVal?: number }).levelVal ?? 30;
  //       const sku = extractSku(args);
  //       if (levelVal < 40 && sku && !skuAllowlist.has(sku)) {
  //         return;
  //       }
  //     }
  //     return method.apply(this, args as any);
  //   },
  // },
});

export default logger;
