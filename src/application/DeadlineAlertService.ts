import { OrderStateRepository } from '../domains/ordering/ports.js';
import { Notifier } from '../shared/ports.js';
import logger from '../shared/logger.js';

const log            = logger.child({ service: 'DeadlineAlertService' });
const ONE_HOUR_MS    = 60 * 60 * 1000;
const flow = 'deadline_alert';

export class DeadlineAlertService {
  constructor(
    private readonly orderRepo: OrderStateRepository,
    private readonly notifier:  Notifier,
  ) {}

  async run(): Promise<void> {
    const startedAt = Date.now();
    const uploaded = await this.orderRepo.getByStatus('uploaded');
    if (uploaded.length === 0) {
      log.info({ flow, event: 'deadline_scan_complete', uploadedCount: 0, alertableCount: 0, sentCount: 0, markAlertedSuccess: 0, markAlertedFailure: 0, durationMs: Date.now() - startedAt }, 'event=deadline_scan_complete deadline scan completed');
      return;
    }

    const now       = Date.now();
    const alertable = uploaded.filter(o =>
      !o.deadlineAlerted &&
      o.latestShipDate &&
      now >= new Date(o.latestShipDate).getTime() - ONE_HOUR_MS,
    );

    if (alertable.length === 0) {
      log.info({ flow, event: 'deadline_scan_complete', uploadedCount: uploaded.length, alertableCount: 0, sentCount: 0, markAlertedSuccess: 0, markAlertedFailure: 0, durationMs: Date.now() - startedAt }, 'event=deadline_scan_complete deadline scan completed');
      return;
    }

    const lines = alertable.map(o => {
      const deadline = new Date(o.latestShipDate!).toLocaleString('en-GB', { timeZone: 'Europe/London' });
      return `• **${o.orderId}** — ${o.customerName} (${o.customerCountry})\n  └ Ship by: ${deadline}`;
    });

    await this.notifier.send(
      `⚠️ ${alertable.length} order(s) approaching shipping deadline`,
      lines.join('\n'),
      'warning',
    );

    let markAlertedSuccess = 0;
    let markAlertedFailure = 0;
    for (const order of alertable) {
      try {
        await this.orderRepo.markDeadlineAlerted(order.orderId);
        markAlertedSuccess++;
      } catch (err) {
        markAlertedFailure++;
        log.error({ flow, event: 'deadline_mark_alerted_failed', err, orderId: order.orderId }, 'event=deadline_mark_alerted_failed failed to mark deadline alerted');
      }
    }
    log.info({
      flow,
      event: 'deadline_scan_complete',
      uploadedCount: uploaded.length,
      alertableCount: alertable.length,
      sentCount: alertable.length,
      markAlertedSuccess,
      markAlertedFailure,
      durationMs: Date.now() - startedAt,
    }, 'event=deadline_scan_complete deadline scan completed');
  }
}
