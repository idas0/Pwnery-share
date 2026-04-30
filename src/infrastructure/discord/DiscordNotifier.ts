import type { Notifier } from '../../shared/ports.js';
import logger from '../../shared/logger.js';

const LEVEL_COLORS = {
  info: 0x3498DB,
  warning: 0xF39C12,
  error: 0xE74C3C,
} as const;

export class DiscordNotifier implements Notifier {
  private readonly log = logger.child({ module: 'DiscordNotifier' });

  constructor(
    private readonly webhookUrl: string = process.env.DISCORD_WEBHOOK_URL ?? '',
  ) {}

  async send(title: string, description: string, level: 'info' | 'warning' | 'error'): Promise<void> {
    if (!this.webhookUrl) {
      this.log.warn('DISCORD_WEBHOOK_URL is not configured');
      return;
    }

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color: LEVEL_COLORS[level],
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (response.ok) return;

    const body = await response.text();
    throw new Error(`DiscordNotifier: webhook failed with status ${response.status}${body ? `: ${body}` : ''}`);
  }
}
