import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { extractMarketplaceIdFromSqsBody, marketplaceQueueMapFromEnv } from '../domains/notifications/router.js';

type SqsRecord = {
  messageId: string;
  body: string;
};

type SqsEvent = {
  Records: SqsRecord[];
};

type BatchFailure = {
  itemIdentifier: string;
};

type RouterResponse = {
  batchItemFailures: BatchFailure[];
};

type PendingMessage = {
  sourceMessageId: string;
  body: string;
};

const sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'eu-north-1' });

function toChunks<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function handler(event: SqsEvent): Promise<RouterResponse> {
  const queueByMarketplaceId = marketplaceQueueMapFromEnv(process.env);
  const grouped = new Map<string, PendingMessage[]>();
  const failed = new Set<string>();

  for (const record of event.Records ?? []) {
    try {
      const marketplaceId = extractMarketplaceIdFromSqsBody(record.body);
      if (!marketplaceId) {
        failed.add(record.messageId);
        continue;
      }
      const targetQueueUrl = queueByMarketplaceId.get(marketplaceId);
      if (!targetQueueUrl) {
        failed.add(record.messageId);
        continue;
      }
      const bucket = grouped.get(targetQueueUrl) ?? [];
      bucket.push({ sourceMessageId: record.messageId, body: record.body });
      grouped.set(targetQueueUrl, bucket);
    } catch {
      failed.add(record.messageId);
    }
  }

  for (const [queueUrl, messages] of grouped.entries()) {
    for (const chunk of toChunks(messages, 10)) {
      const entries = chunk.map((message, idx) => ({
        Id: String(idx),
        MessageBody: message.body,
      }));
      const result = await sqs.send(new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: entries,
      }));
      const idToSource = new Map(entries.map((entry, idx) => [entry.Id, chunk[idx].sourceMessageId]));
      for (const fail of result.Failed ?? []) {
        const sourceId = fail.Id ? idToSource.get(fail.Id) : null;
        if (sourceId) failed.add(sourceId);
      }
    }
  }

  return {
    batchItemFailures: Array.from(failed).map((itemIdentifier) => ({ itemIdentifier })),
  };
}
