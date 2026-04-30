import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ExchangeRateRepository } from '../../domains/pricing/ports.js';
import logger from '../../shared/logger.js';

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const TABLE   = 'exchange-rates';

export function parseEcbXml(xml: string, currency: string): number {
  const q = `["']`;
  const rate =
    xml.match(new RegExp(`<Cube[^>]+currency=${q}${currency}${q}[^>]+rate=${q}([\\d.]+)${q}`, 'i'))?.[1] ??
    xml.match(new RegExp(`<Cube[^>]+rate=${q}([\\d.]+)${q}[^>]+currency=${q}${currency}${q}`, 'i'))?.[1];

  if (!rate) throw new Error(`EcbFxService: ${currency} not found in ECB XML`);
  const n = parseFloat(rate);
  if (!isFinite(n) || n <= 0) throw new Error(`EcbFxService: invalid rate for ${currency}: ${rate}`);
  return n;
}

export class EcbFxService implements ExchangeRateRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly log = logger.child({ module: 'EcbFxService' });
  private readonly flow = 'infra_fx';
  private cachedXml: string | null = null;
  private readonly memCache = new Map<string, number>();

  constructor() {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env.AWS_REGION ?? 'eu-north-1',
      ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
    }));
  }

  async getRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;

    const pair = `${from}-${to}`;
    const cached = this.memCache.get(pair);
    if (cached !== undefined) return cached;

    try {
      const rate = await this.deriveFromEcb(from, to);
      this.memCache.set(pair, rate);
      await this.persistToDb(from, to, rate);
      this.log.debug({ flow: this.flow, event: 'rate_fetched', pair, rate }, 'event=rate_fetched exchange rate fetched from ECB');
      return rate;
    } catch (ecbErr) {
      const msg = ecbErr instanceof Error ? ecbErr.message : String(ecbErr);
      const stored = await this.loadFromDb(from, to);
      if (stored) {
        this.log.warn({
          flow: this.flow,
          event: 'rate_fallback_to_stored',
          pair,
          rate: stored.rate,
          updatedAt: stored.updatedAt,
          ecbErr: msg,
        }, 'event=rate_fallback_to_stored ECB unavailable, using stored rate');
        this.memCache.set(pair, stored.rate);
        return stored.rate;
      }
      throw new Error(`EcbFxService: cannot get ${pair} — ECB failed (${msg}) and no stored rate`);
    }
  }

  private async fetchXml(): Promise<string> {
    if (this.cachedXml) return this.cachedXml;
    const res = await fetch(ECB_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ECB`);
    this.cachedXml = await res.text();
    return this.cachedXml;
  }

  private async deriveFromEcb(from: string, to: string): Promise<number> {
    const xml = await this.fetchXml();
    const eurFrom = from === 'EUR' ? 1 : parseEcbXml(xml, from);
    const eurTo   = to   === 'EUR' ? 1 : parseEcbXml(xml, to);
    return eurTo / eurFrom;
  }

  private async loadFromDb(from: string, to: string): Promise<{ rate: number; updatedAt: string } | null> {
    const result = await this.client.send(new GetCommand({
      TableName: TABLE,
      Key: { pair: `${from}-${to}` },
    }));
    if (!result.Item) return null;
    return { rate: result.Item['rate'], updatedAt: result.Item['updatedAt'] };
  }

  private async persistToDb(from: string, to: string, rate: number): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: TABLE,
        Item: { pair: `${from}-${to}`, rate, updatedAt: new Date().toISOString() },
      }));
    } catch (err) {
      this.log.warn({
        flow: this.flow,
        event: 'rate_persist_failed',
        pair: `${from}-${to}`,
        err,
      }, 'event=rate_persist_failed failed to persist exchange rate');
    }
  }
}
