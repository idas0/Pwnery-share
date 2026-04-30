import { create } from 'xmlbuilder2';

export interface WortmannOrderXmlCustomer {
  name: string;
  companyName?: string;
  address: string;
  zip: string;
  city: string;
  country: string;
  phone?: string;
}

export interface WortmannOrderXmlLine {
  sku: string;
  quantity: number;
  price: number;
}

export function buildWortmannOrderXml(
  orderId: string,
  currency: string,
  partyId: string,
  customer: WortmannOrderXmlCustomer,
  lines: WortmannOrderXmlLine[],
): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('ORDER', {
      'xmlns:bmecat': 'http://www.bmecat.org/bmecat/2005',
      version: '2.1',
      type: 'standard',
      xmlns: 'http://www.opentrans.org/XMLSchema/2.1',
    })
    .ele('ORDER_HEADER')
      .ele('CONTROL_INFO')
        .ele('GENERATION_DATE')
          .txt(new Date().toISOString().slice(0, 16))
        .up()
      .up()
      .ele('ORDER_INFO')
        .ele('ORDER_ID')
          .txt(orderId)
        .up()
        .ele('ORDER_DATE')
          .txt(new Date().toISOString().slice(0, 10))
        .up()
        .ele('PARTIES')
          .ele('PARTY')
            .ele('bmecat:PARTY_ID', { type: 'supplier_specific' })
              .txt(partyId)
            .up()
            .ele('PARTY_ROLE')
              .txt('buyer')
            .up()
          .up()
          .ele('PARTY')
            .ele('bmecat:PARTY_ID', { type: 'supplier_specific' })
              .txt(partyId)
            .up()
            .ele('PARTY_ROLE')
              .txt('delivery')
            .up()
            .ele('ADDRESS')
              .ele('bmecat:NAME')
                .txt(customer.name)
              .up()
              .ele('bmecat:NAME2')
                .txt(customer.companyName || '')
              .up()
              .ele('bmecat:STREET')
                .txt(customer.address)
              .up()
              .ele('bmecat:ZIP')
                .txt(customer.zip)
              .up()
              .ele('bmecat:CITY')
                .txt(customer.city)
              .up()
              .ele('bmecat:COUNTRY_CODED')
                .txt(customer.country)
              .up()
              .ele('bmecat:PHONE')
                .txt(customer.phone || '')
              .up()
            .up()
          .up()
          .ele('PARTY')
            .ele('bmecat:PARTY_ID', { type: 'supplier_specific' })
              .txt(partyId)
            .up()
            .ele('PARTY_ROLE')
              .txt('invoice_recipient')
            .up()
          .up()
        .up()
        .ele('DOCEXCHANGE_PARTIES_REFERENCE')
          .ele('DOCUMENT_RECIPIENT_IDREF', { type: 'supplier_specific' })
            .txt('WMA')
          .up()
        .up()
        .ele('bmecat:CURRENCY')
          .txt(currency)
        .up()
      .up()
    .up();

  const itemListElement = doc.ele('ORDER_ITEM_LIST');
  lines.forEach((item, index) => {
    itemListElement
      .ele('ORDER_ITEM')
        .ele('LINE_ITEM_ID')
          .txt(String(index + 1))
        .up()
        .ele('PRODUCT_ID')
          .ele('bmecat:SUPPLIER_PID', { type: 'supplier_specific' })
            .txt(item.sku)
          .up()
        .up()
        .ele('QUANTITY')
          .txt(String(item.quantity))
        .up()
        .ele('bmecat:ORDER_UNIT')
          .txt('C62')
        .up()
        // TODO: not including price for now, because we're not saving base price in the database
        // .ele('PRODUCT_PRICE_FIX') 
        //   .ele('bmecat:PRICE_AMOUNT')
        //     .txt(item.price.toFixed(2))
        //   .up()
        // .up()
      .up();
  });
  itemListElement.up();

  return doc.end({ prettyPrint: true });
}
