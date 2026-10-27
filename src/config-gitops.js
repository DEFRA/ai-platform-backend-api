/**
 * The `gitops` section of the convict schema: the state repositories, the
 * GitOps queues, and the deadlines and sweeps of the operation state machine.
 * It lives apart from `config.js` to keep that file short.
 */
export const gitopsConfigSchema = {
  tenantsRepo: {
    doc: 'owner/repo holding team files (environments/{env}/{slug}.json), read for the current and previous document',
    format: String,
    default: 'DEFRA/ai-platform-tenants',
    env: 'GITOPS_TENANTS_REPO'
  },
  deploymentsRepo: {
    doc: "owner/repo holding platform pins (environments/{env}/platform.json), read for a pin's blob SHA",
    format: String,
    default: 'DEFRA/ai-platform-deployments',
    env: 'GITOPS_DEPLOYMENTS_REPO'
  },
  verifyMaxAttempts: {
    doc: 'How many times ARM may fail to confirm a deployed team before the deployment fails for good with the verifier reason; a Platform Admin retry starts the count again',
    format: 'nat',
    default: 5,
    env: 'GITOPS_VERIFY_MAX_ATTEMPTS'
  },
  commandsTopicArn: {
    doc: 'ARN of the backend-owned commands topic (aip_gitops_commands.fifo), which the backend publishes commands to and the worker queue is subscribed to; required when tenantOrchestrator is sqs',
    format: String,
    nullable: true,
    default: null,
    env: 'GITOPS_COMMANDS_TOPIC_ARN'
  },
  eventsQueueUrl: {
    doc: 'URL of the backend-owned events queue (aip_gitops_events.fifo), which the backend reads status events from; the worker topic is subscribed to it and the workflows send to it; required when tenantOrchestrator is sqs',
    format: String,
    nullable: true,
    default: null,
    env: 'GITOPS_EVENTS_QUEUE_URL'
  },
  awsSqsEndpoint: {
    doc: 'SQS endpoint override for local runs (Floci); unset on CDP',
    format: String,
    nullable: true,
    default: null,
    env: 'AWS_SQS_ENDPOINT'
  },
  awsSnsEndpoint: {
    doc: 'SNS endpoint override for local runs (Floci); unset on CDP',
    format: String,
    nullable: true,
    default: null,
    env: 'AWS_SNS_ENDPOINT'
  },
  awsRegion: {
    doc: 'AWS region of the GitOps queue and topic',
    format: String,
    default: 'eu-west-2',
    env: 'AWS_REGION'
  },
  handlerTimeoutMs: {
    doc: 'How long in ms the events handler may take for one message; the queue visibility timeout (60 s) must stay above it',
    format: 'nat',
    default: 30000,
    env: 'HANDLER_TIMEOUT_MS'
  },
  sqsWaitTimeSeconds: {
    doc: 'Long polling wait in seconds for the events queue',
    format: 'nat',
    default: 20,
    env: 'SQS_WAIT_TIME_SECONDS'
  },
  outboxSweepMs: {
    doc: 'How often in ms the relay publishes outbox entries the request path did not',
    format: 'nat',
    default: 2000,
    env: 'GITOPS_OUTBOX_SWEEP_MS'
  },
  sweepIntervalMs: {
    doc: 'How often in ms the deadline sweeper looks for overdue operations and due verification retries',
    format: 'nat',
    default: 15000,
    env: 'GITOPS_SWEEP_INTERVAL_MS'
  },
  reconcileGraceMs: {
    doc: 'How long in ms an operation gets after the worker is asked to reconcile it, before it times out with no progress',
    format: 'nat',
    default: 600000,
    env: 'GITOPS_RECONCILE_GRACE_MS'
  },
  deadlineRequestedMs: {
    doc: 'Deadline in ms from entering requested',
    format: 'nat',
    default: 600000,
    env: 'GITOPS_DEADLINE_REQUESTED_MS'
  },
  deadlineCommittedMs: {
    doc: 'Deadline in ms from entering committed',
    format: 'nat',
    default: 1800000,
    env: 'GITOPS_DEADLINE_COMMITTED_MS'
  },
  deadlineDeployingMs: {
    doc: 'Deadline in ms from entering deploying',
    format: 'nat',
    default: 2700000,
    env: 'GITOPS_DEADLINE_DEPLOYING_MS'
  },
  deadlineDeployedMs: {
    doc: 'Deadline in ms from entering deployed (ARM verification included)',
    format: 'nat',
    default: 900000,
    env: 'GITOPS_DEADLINE_DEPLOYED_MS'
  },
  resubmitMax: {
    doc: 'How many times a write the workflow refused as stale-revision or commit-conflict is rebuilt from main and resubmitted before it times out',
    format: 'nat',
    default: 3,
    env: 'GITOPS_RESUBMIT_MAX'
  },
  revertGraceMs: {
    doc: 'How long in ms a revert waits before it is published, in case the failed apply recovers',
    format: 'nat',
    default: 300000,
    env: 'GITOPS_REVERT_GRACE_MS'
  },
  deadlineHeldMs: {
    doc: 'Deadline in ms of an operation held while its environment is paused, doubling each time up to 4 hours',
    format: 'nat',
    default: 1800000,
    env: 'GITOPS_DEADLINE_HELD_MS'
  },
  heldAlarmMs: {
    doc: 'How long in ms an operation may stay held or deferred before the backend raises an alarm',
    format: 'nat',
    default: 3600000,
    env: 'GITOPS_HELD_ALARM_MS'
  }
}
