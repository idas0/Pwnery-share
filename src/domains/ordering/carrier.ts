const STANDARD_CARRIER_CODES = new Set([
  'Amazon Shipping',
  'AMZL',
  'AMZL_UK',
  'DHL',
  'DHL eCommerce',
  'DHL Express',
  'DHL Freight',
  'DHL Global Mail',
  'DHL Home Delivery',
  'DHL Parcel UK',
  'DHL-Paket',
  'DPD',
  'DPD Local',
  'Deutsche Post',
  'FedEx',
  'FedEx SmartPost',
  'GLS',
  'GLS Canada',
  'GLS US',
  'Hermes',
  'Hermes UK',
  'Other',
  'Royal Mail',
  'TNT',
  'UPS',
  'UPS Freight',
  'UPS Mail Innovations',
  'UPSMI',
  'Yodel',
]);

const STANDARD_CARRIER_ALIASES: Record<string, string> = {
  amzl: 'AMZL',
  'amzl uk': 'AMZL_UK',
  'amazon shipping': 'Amazon Shipping',
  dhl: 'DHL',
  'dhl ecommerce': 'DHL eCommerce',
  'dhl express': 'DHL Express',
  'dhl freight': 'DHL Freight',
  'dhl paket': 'DHL-Paket',
  'dhl-paket': 'DHL-Paket',
  dpd: 'DPD',
  'dpd local': 'DPD Local',
  'deutsche post': 'Deutsche Post',
  fedex: 'FedEx',
  'fed ex': 'FedEx',
  'fedex smartpost': 'FedEx SmartPost',
  'fedex smart post': 'FedEx SmartPost',
  gls: 'GLS',
  hermes: 'Hermes',
  'hermes uk': 'Hermes UK',
  'royal mail': 'Royal Mail',
  'smartpost bm': 'FedEx SmartPost',
  'smartpost-bm': 'FedEx SmartPost',
  'smart post': 'FedEx SmartPost',
  smartpost: 'FedEx SmartPost',
  tnt: 'TNT',
  'united parcel service': 'UPS',
  'ups great britain': 'UPS',
  'ups deutschland': 'UPS',
  'ups europe': 'UPS',
  ups: 'UPS',
  'ups freight': 'UPS Freight',
  'ups mail innovations': 'UPS Mail Innovations',
  upsmi: 'UPSMI',
  yodel: 'Yodel',
};

function normaliseToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function getStandardCarrierCode(raw: string | undefined): string | null {
  const candidate = raw?.trim();
  if (!candidate) return null;
  return STANDARD_CARRIER_CODES.has(candidate) ? candidate : null;
}

export function normaliseCarrier(
  carrierCode: string | undefined,
  carrierName: string | undefined,
): { carrierCode: string; carrierName: string } {
  const exactMatches = [carrierName, carrierCode]
    .map(getStandardCarrierCode)
    .filter((value): value is string => value !== null && value !== 'Other');
  if (exactMatches.length > 0) {
    return { carrierCode: exactMatches[0], carrierName: exactMatches[0] };
  }

  const rawCandidates = [carrierName, carrierCode]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of rawCandidates) {
    const mappedCode = STANDARD_CARRIER_ALIASES[normaliseToken(candidate)];
    if (mappedCode) {
      return { carrierCode: mappedCode, carrierName: mappedCode };
    }
  }

  for (const candidate of rawCandidates) {
    const token = normaliseToken(candidate);
    for (const [alias, mappedCode] of Object.entries(STANDARD_CARRIER_ALIASES)) {
      if (token.includes(alias)) {
        return { carrierCode: mappedCode, carrierName: mappedCode };
      }
    }
  }

  throw new Error(
    `Unable to normalise carrier: carrierCode=${carrierCode ?? '<missing>'}, carrierName=${carrierName ?? '<missing>'}`,
  );
}
