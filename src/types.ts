export type TrafficClass =
  | "cold_outbound"
  | "follow_up"
  | "warmup_send"
  | "reply"
  | "personal"
  | "transactional";

export const KNOWN_TRAFFIC_CLASSES: readonly TrafficClass[] = [
  "cold_outbound",
  "follow_up",
  "warmup_send",
  "reply",
  "personal",
  "transactional",
] as const;

export type EventCategory = "send" | "bounce" | "reply" | "complaint" | "unsubscribe";

export type EventResult = "ok" | "error" | "blocked" | "deferred" | "observed";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type WorkingHours = { start: string; end: string };

export type MailboxPolicy = {
  timezone: string;
  workingHours: WorkingHours;
  workingDays: Weekday[];
  limits: {
    send: { perDay: number; perHour: number; minGapSeconds: number };
    perRecipientDomainPerHour: number;
  };
  warmup: {
    enabled: boolean;
    startPerDay: number;
    rampPerDay: number;
    plateauPerDay: number;
  };
};

export type JitterConfig = {
  enabled: boolean;
  distribution: "uniform" | "lognormal";
  uniform?: { minSeconds: number; maxSeconds: number };
  lognormal?: { medianSeconds: number; sigma: number };
  clampSeconds: { min: number; max: number };
  microPause: {
    probability: number;
    durationSeconds: { min: number; max: number };
  };
  sendOutsideWorkingHours: "defer" | "allow" | "deny";
};

export type TripwireWindow = { sends: number } | { hours: number; minSends: number };

export type TripwireAction =
  | "alert"
  | "pause-mailbox"
  | "pause-warmup"
  | "pause-campaign"
  | "suppress-recipient";

export type Tripwire = {
  classes?: TrafficClass[];
  window?: TripwireWindow;
  maxRate?: number;
  minRate?: number;
  action: TripwireAction;
};

export type GmailPubsubAdapterConfig = {
  kind: "gmail-pubsub";
  enabled?: boolean;
  mode?: "push" | "pull";
  topic?: string;
  subscription?: string;
  pushPath?: string;
  secretEnv?: string;
  mailboxes?: string[];
  labelsToCapture?: string[];
};

export type GmailPollAdapterConfig = {
  kind: "gmail-poll";
  enabled?: boolean;
  mailboxes?: string[];
  pollSeconds?: number;
  labelsToCapture?: string[];
  historyIdStateKey?: string;
};

export type IngestionAdapterConfig = GmailPubsubAdapterConfig | GmailPollAdapterConfig;

export type IngestionAdapterContext = {
  recordEvent: (event: RecordEventInput) => Promise<void>;
  logger: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
};

export type IngestionAdapter = {
  readonly id: string;
  readonly kind: IngestionAdapterConfig["kind"];
  start(ctx: IngestionAdapterContext): Promise<void>;
  stop(): Promise<void>;
};

export type PluginConfig = {
  enabled: boolean;
  stateDir: string;
  mailboxes: {
    default: MailboxPolicy;
    overrides?: Record<string, Partial<MailboxPolicy>>;
  };
  jitter: JitterConfig;
  tripwires: Record<string, Tripwire>;
  suppression: { scope: "global" | "per-mailbox"; honorUnsubscribeWithinHours: number };
  retention: { maxEvents: number; dailyRetentionDays: number; perDomainRetentionDays: number };
  alerts: { slackChannel?: string; onPause: boolean; onDailyRollup: boolean };
  ingestion: { adapters: IngestionAdapterConfig[] };
};

export type LedgerEvent = {
  t: string;
  cat: EventCategory;
  class: TrafficClass;
  cost: number;
  result: EventResult;
  recipient?: string;
  messageId?: string;
  sendAfter?: string;
  reason?: string;
  errorStatus?: number;
};

export type DailyBucket = { calls: number; penalty: number };

export type MailboxLedger = {
  version: 1;
  mailbox: string;
  tier: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  warmup: { stage: number; plateauReachedAt: string | null };
  pausedUntil?: string;
  pausedReason?: string;
  aggregates: {
    daily: Record<string, Record<EventCategory, DailyBucket>>;
    monthly: Record<string, Record<EventCategory, DailyBucket>>;
    perRecipientDomain: Record<string, Record<string, number>>;
  };
  lastCallAt: Partial<Record<EventCategory, string>>;
  lastCooldownAt: Record<string, string>;
  suppressed: Array<{ recipient: string; reason: string; at: string }>;
  events: LedgerEvent[];
};

export type Decision =
  | { decision: "allow"; class: TrafficClass }
  | { decision: "defer"; class: TrafficClass; sendAfter: string; reason: string }
  | { decision: "deny"; reason: string }
  | { decision: "suppressed"; reason: string };

export type CheckSendInput = {
  mailbox: string;
  recipient: string;
  trafficClass?: string;
  cost?: number;
  campaignContext?: boolean;
};

export type RecordSendInput = {
  mailbox: string;
  recipient: string;
  class: TrafficClass;
  cost?: number;
  result: EventResult;
  messageId?: string;
  errorStatus?: number;
  reason?: string;
};

export type RecordEventInput = {
  mailbox: string;
  cat: Exclude<EventCategory, "send">;
  class: TrafficClass;
  recipient: string;
  reason?: string;
};
