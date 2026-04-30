import { collectFirst, collectNodes, collectValues, parseXml } from '../../../common/xmlHelpers.js';
import { normaliseCarrier } from '../../../domains/ordering/carrier.js';

export interface WortmannDeliveryNote {
  filename:       string;
  orderId:        string;
  trackingNumber: string;
  carrierCode:    string;
  carrierName:    string;
  shipDate:       string;
}

export function parseWortmannDeliveryNoteXml(xml: string, filename: string): WortmannDeliveryNote | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseXml(xml);
  } catch {
    return null;
  }

  const root = Object.keys(doc).find((k) => !k.startsWith('?') && !k.startsWith('@'));
  if (!root || !root.toUpperCase().includes('DISPATCH')) return null;

  const trackingNumber = collectFirst(doc, 'SHIPMENT_ID') || '';
  if (!trackingNumber) return null;

  const customerRefs = collectNodes(doc, 'CUSTOMER_ORDER_REFERENCE');
  const orderIds: string[] = [];
  for (const ref of customerRefs) {
    const oid = collectFirst(ref as Record<string, unknown>, 'ORDER_ID');
    if (oid) orderIds.push(oid);
  }

  if (orderIds.length === 0) {
    orderIds.push(
      ...collectValues(doc, 'ORDER_ID'),
      ...collectValues(doc, 'CUSTOMER_ORDER_ID'),
    );
  }

  const unique = [...new Set(orderIds)];
  if (unique.length === 0) return null;

  const orderId = unique[0];

  const shipDate =
    collectFirst(doc, 'DISPATCHNOTIFICATION_DATE')
    || collectFirst(doc, 'GENERATION_DATE')
    || new Date().toISOString().slice(0, 10);

  const packageDescr = collectFirst(doc, 'PACKAGE_DESCR') || '';
  const { carrierCode, carrierName } = normaliseCarrier(undefined, packageDescr);

  return {
    filename,
    orderId,
    trackingNumber,
    carrierCode,
    carrierName,
    shipDate,
  };
}
