import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteMessageBatchCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { DynamoAttributesRepository } from '../dynamo/DynamoAttributesRepository.js';
import { SQSNotificationEnvelope, AnyOfferChangedPayload, B2BAnyOfferChangedPayload } from '../amazon/snapshotBuilder.js';
import { WakeUpMessage } from './SqsPublisher.js';
import logger from '../../shared/logger.js';

const LONG_POLL_WAIT_S = 20;
const MAX_MESSAGES     = 10;
const flow = 'repricer_consumer';

export class SqsConsumer {
  private running = false;
  private readonly log = logger.child({ infra: 'SqsConsumer' });

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueUrl: string,
    private readonly attributesRepo: DynamoAttributesRepository,
    private readonly onMarketUpdate: (sku: string, payload: AnyOfferChangedPayload) => Promise<void>,
    private readonly onB2BMarketUpdate: (sku: string, payload: B2BAnyOfferChangedPayload) => Promise<void>,
    private readonly onWakeUp: (
      sku: string,
      triggeredAt: number,
    ) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.log.info({ flow, event: 'consumer_started', queueUrl: this.queueUrl }, 'event=consumer_started SQS consumer started');

    while (this.running) {
      try {
        const resp = await this.sqsClient.send(new ReceiveMessageCommand({
          QueueUrl:            this.queueUrl,
          MaxNumberOfMessages: MAX_MESSAGES,
          WaitTimeSeconds:     LONG_POLL_WAIT_S,
          AttributeNames:      ['All'],
        }));

        const messages = resp.Messages ?? [];
        if (messages.length > 0) await this.processBatch(messages);
      } catch (err) {
        this.log.error({ flow, event: 'receive_failed', err }, 'event=receive_failed SQS receive failed, retrying in 5s');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const uniqueMessages    = new Map<string, { msg: Message; payload: AnyOfferChangedPayload }>();
    const uniqueB2BMessages = new Map<string, { msg: Message; payload: B2BAnyOfferChangedPayload }>();
    const wakeUpMessages: { msg: Message; body: WakeUpMessage }[] = [];
    const duplicateHandles: string[] = [];

    for (const msg of messages) {
      try {
        const parsed = JSON.parse(msg.Body!);

        if (parsed.NotificationType === 'WAKE_UP') {
          wakeUpMessages.push({ msg, body: parsed as WakeUpMessage });
          continue;
        }

        const outer = parsed;
        const envelope: SQSNotificationEnvelope = outer.Message ? JSON.parse(outer.Message) : outer;
        const incomingTs = Number(msg.Attributes?.SentTimestamp ?? 0);

        if (envelope.NotificationType === 'ANY_OFFER_CHANGED') {
          const notif = envelope.Payload?.AnyOfferChangedNotification;
          if (!notif || notif.OfferChangeTrigger.ItemCondition.toLowerCase() !== 'new') continue;
          const sku = await this.attributesRepo.asinToSku(notif.OfferChangeTrigger.ASIN);
          if (!sku) continue;

          const existing = uniqueMessages.get(sku);
          if (existing) {
            const existingTs = Number(existing.msg.Attributes?.SentTimestamp ?? 0);
            if (incomingTs > existingTs) {
              duplicateHandles.push(existing.msg.ReceiptHandle!);
              uniqueMessages.set(sku, { msg, payload: notif as AnyOfferChangedPayload });
            } else {
              duplicateHandles.push(msg.ReceiptHandle!);
            }
          } else {
            uniqueMessages.set(sku, { msg, payload: notif as AnyOfferChangedPayload });
          }
          continue;
        }

        if (envelope.NotificationType === 'B2B_ANY_OFFER_CHANGED') {
          const notif = envelope.Payload?.B2BAnyOfferChangedNotification;
          if (!notif || notif.OfferChangeTrigger.ItemCondition.toLowerCase() !== 'new') continue;
          const sku = await this.attributesRepo.asinToSku(notif.OfferChangeTrigger.ASIN);
          if (!sku) continue;

          const existing = uniqueB2BMessages.get(sku);
          if (existing) {
            const existingTs = Number(existing.msg.Attributes?.SentTimestamp ?? 0);
            if (incomingTs > existingTs) {
              duplicateHandles.push(existing.msg.ReceiptHandle!);
              uniqueB2BMessages.set(sku, { msg, payload: notif as B2BAnyOfferChangedPayload });
            } else {
              duplicateHandles.push(msg.ReceiptHandle!);
            }
          } else {
            uniqueB2BMessages.set(sku, { msg, payload: notif as B2BAnyOfferChangedPayload });
          }
          continue;
        }
      } catch (err) {
        this.log.error({ flow, event: 'message_parse_failed', err, messageId: msg.MessageId }, 'event=message_parse_failed failed to parse SQS message');
      }
    }

    if (duplicateHandles.length > 0) {
      this.log.debug({ flow, event: 'duplicate_messages_discarded', count: duplicateHandles.length }, 'event=duplicate_messages_discarded duplicate SKU messages removed');
      await this.sqsClient.send(new DeleteMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries:  duplicateHandles.map((handle, i) => ({ Id: String(i), ReceiptHandle: handle })),
      }));
    }

    await Promise.allSettled([
      ...Array.from(uniqueMessages.entries()).map(async ([sku, { msg, payload }]) => {
        try {
          await this.onMarketUpdate(sku, payload);
          await this.sqsClient.send(new DeleteMessageCommand({
            QueueUrl:      this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle!,
          }));
        } catch (err) {
          this.log.error({ flow, event: 'market_handler_failed', err, sku }, 'event=market_handler_failed market update handler failed, message will redeliver');
        }
      }),
      ...Array.from(uniqueB2BMessages.entries()).map(async ([sku, { msg, payload }]) => {
        try {
          await this.onB2BMarketUpdate(sku, payload);
          await this.sqsClient.send(new DeleteMessageCommand({
            QueueUrl:      this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle!,
          }));
        } catch (err) {
          this.log.error({ flow, event: 'b2b_handler_failed', err, sku }, 'event=b2b_handler_failed B2B market update handler failed, message will redeliver');
        }
      }),
      ...wakeUpMessages.map(async ({ msg, body }) => {
        try {
          await this.onWakeUp(body.sku, body.triggeredAt);
          await this.sqsClient.send(new DeleteMessageCommand({
            QueueUrl:      this.queueUrl,
            ReceiptHandle: msg.ReceiptHandle!,
          }));
        } catch (err) {
          this.log.error({ flow, event: 'wakeup_handler_failed', err, sku: body.sku }, 'event=wakeup_handler_failed wake-up handler failed, message will redeliver');
        }
      }),
    ]);
  }
}
