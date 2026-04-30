import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import logger from '../../shared/logger.js';

export interface WakeUpMessage {
  NotificationType: 'WAKE_UP';
  sku: string;
  triggeredAt: number;
}

export class SqsPublisher {
  private readonly log = logger.child({ infra: 'SqsPublisher' });
  private readonly flow = 'repricer_scheduler';

  constructor(
    private readonly schedulerClient: SchedulerClient,
    private readonly queueArn?: string,
    private readonly schedulerRoleArn?: string,
    private readonly schedulerGroupName = 'default',
  ) {}

  async enqueueTimeout(
    sku: string,
    timeoutMs: number,
  ): Promise<void> {
    if (!this.queueArn) throw new Error('SQS_QUEUE_ARN env var is required for EventBridge Scheduler timeouts');
    if (!this.schedulerRoleArn) throw new Error('EVENTBRIDGE_SCHEDULER_ROLE_ARN env var is required for EventBridge Scheduler timeouts');

    const wakeUpMs = Math.max(0, timeoutMs);
    const scheduleAt = new Date(Date.now() + wakeUpMs);
    const scheduleName = `wake-up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const triggeredAt = Date.now();
    const body: WakeUpMessage = { NotificationType: 'WAKE_UP', sku, triggeredAt };
    const scheduleExpression = `at(${scheduleAt.toISOString().slice(0, 19)})`;

    await this.schedulerClient.send(new CreateScheduleCommand({
      Name: scheduleName,
      GroupName: this.schedulerGroupName,
      ActionAfterCompletion: 'DELETE',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ScheduleExpression: scheduleExpression,
      Target: {
        Arn: this.queueArn,
        RoleArn: this.schedulerRoleArn,
        Input: JSON.stringify(body),
      },
    }));
    this.log.debug({
      flow: this.flow,
      event: 'wakeup_enqueued',
      sku,
      triggeredAt,
      timeoutMs: wakeUpMs,
      scheduleAt: scheduleAt.toISOString(),
      scheduleName,
    }, 'event=wakeup_enqueued wake-up timeout enqueued');
  }
}
