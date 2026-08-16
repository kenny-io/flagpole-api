/**
 * Webhook subscriptions and delivery history.
 *
 * Subscriptions are in-memory like the flag store: Flagpole is a reference
 * implementation, so durability is deliberately out of scope. Deliveries are
 * recorded rather than sent — the transport is the caller's concern — which
 * keeps the endpoint surface testable without a network.
 */

export type WebhookEvent =
  | "flag.created"
  | "flag.updated"
  | "flag.deleted"
  | "tag.retired";

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  "flag.created",
  "flag.updated",
  "flag.deleted",
  "tag.retired",
];

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  createdAt: string;
}

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  status: DeliveryStatus;
  attempts: number;
  at: string;
}

export interface WebhookRegistry {
  /** Register a subscription. The id is assigned by the registry. */
  create(input: {
    url: string;
    events: WebhookEvent[];
    secret?: string;
  }): Webhook;
  /** Every registered subscription, oldest first. */
  list(): Webhook[];
  /** One subscription, or `undefined` when the id is unknown. */
  get(id: string): Webhook | undefined;
  /** Remove a subscription. `true` when one was removed. */
  delete(id: string): boolean;
  /**
   * Record a delivery for every subscription listening to `event`, returning
   * the deliveries created. A subscription that does not subscribe to the
   * event is skipped.
   */
  dispatch(event: WebhookEvent): WebhookDelivery[];
  /**
   * Delivery history for one subscription, newest first. `status` filters by
   * outcome; `limit` keeps the most recent `n`.
   */
  deliveries(
    webhookId: string,
    options?: { status?: DeliveryStatus; limit?: number },
  ): WebhookDelivery[] | undefined;
}

export const MAX_WEBHOOK_URL_LENGTH = 2048;

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}_${sequence.toString(36).padStart(6, "0")}`;
};

/** Create an empty registry. Each call is fully isolated. */
export function createWebhookRegistry(): WebhookRegistry {
  const webhooks = new Map<string, Webhook>();
  const deliveries = new Map<string, WebhookDelivery[]>();

  return {
    create({ url, events, secret }) {
      const webhook: Webhook = {
        id: nextId("wh"),
        url,
        events: [...events],
        createdAt: new Date().toISOString(),
      };
      if (secret !== undefined) webhook.secret = secret;
      webhooks.set(webhook.id, webhook);
      deliveries.set(webhook.id, []);
      return webhook;
    },

    list() {
      return [...webhooks.values()];
    },

    get(id) {
      return webhooks.get(id);
    },

    delete(id) {
      deliveries.delete(id);
      return webhooks.delete(id);
    },

    dispatch(event) {
      const created: WebhookDelivery[] = [];
      for (const webhook of webhooks.values()) {
        if (!webhook.events.includes(event)) continue;
        const delivery: WebhookDelivery = {
          id: nextId("dlv"),
          webhookId: webhook.id,
          event,
          status: "pending",
          attempts: 0,
          at: new Date().toISOString(),
        };
        deliveries.get(webhook.id)?.unshift(delivery);
        created.push(delivery);
      }
      return created;
    },

    deliveries(webhookId, options = {}) {
      const history = deliveries.get(webhookId);
      if (!history) return undefined;
      const filtered = options.status
        ? history.filter((delivery) => delivery.status === options.status)
        : [...history];
      return options.limit === undefined
        ? filtered
        : filtered.slice(0, options.limit);
    },
  };
}
