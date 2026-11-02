/**
 * Tools for the example support agent. Each one reads or writes an in-memory
 * fake order database, and each is exported already wrapped with
 * `recordTool()`, so inside `replay()` its calls are recorded and replayed
 * like the model calls are.
 */
import { recordTool } from "agent-retrace";

/** One order in the fake database. */
export interface Order {
  id: string;
  item: string;
  status: "processing" | "shipped" | "delivered";
  totalCents: number;
  /** ISO date the order was delivered, once it has been. */
  deliveredOn?: string;
  /** ISO date the order is expected, while it is on its way. */
  expectedOn?: string;
  carrier?: string;
}

/** A refund the agent issued. */
export interface Refund {
  refundId: string;
  orderId: string;
  amountCents: number;
  reason: string;
}

/** One store policy the agent can quote. */
export interface Policy {
  id: string;
  title: string;
  text: string;
}

const ORDERS: ReadonlyMap<string, Order> = new Map([
  [
    "A1",
    {
      id: "A1",
      item: "Ceramic coffee mug",
      status: "delivered",
      totalCents: 1800,
      deliveredOn: "2026-10-30",
    },
  ],
  [
    "B2",
    {
      id: "B2",
      item: "Wool throw blanket",
      status: "shipped",
      totalCents: 6400,
      expectedOn: "2026-11-05",
      carrier: "UPS",
    },
  ],
]);

const POLICIES: readonly Policy[] = [
  {
    id: "damaged-items",
    title: "Damaged or broken items",
    text: "If an item arrives damaged or broken, refund it in full. The customer does not need to return it.",
  },
  {
    id: "late-delivery",
    title: "Late deliveries",
    text: "Orders that are more than 7 days past their expected date may be replaced. Before that, share the tracking status.",
  },
  {
    id: "returns",
    title: "Returns",
    text: "Unused items can be returned within 30 days of delivery for a refund.",
  },
];

/**
 * Looks up an order by id.
 *
 * @param args - The order id.
 * @returns The order, or an `error` when there is no such order.
 */
function lookupOrderImpl(args: { orderId: string }): Order | { error: string } {
  return ORDERS.get(args.orderId) ?? { error: `No order with id ${args.orderId}.` };
}

/**
 * Refunds an order in full.
 *
 * @param args - The order id and the reason for the refund.
 * @returns The refund issued.
 * @throws {Error} When there is no such order.
 */
function issueRefundImpl(args: { orderId: string; reason: string }): Refund {
  const order = ORDERS.get(args.orderId);
  if (order === undefined) throw new Error(`No order with id ${args.orderId}.`);
  return {
    refundId: `R-${order.id}`,
    orderId: order.id,
    amountCents: order.totalCents,
    reason: args.reason,
  };
}

/**
 * Finds the store policies that share a word with the query.
 *
 * @param args - The search query.
 * @returns The matching policies, or all of them when none match.
 */
function searchPoliciesImpl(args: { query: string }): Policy[] {
  const words = args.query.toLowerCase().match(/[a-z]+/g) ?? [];
  const hits = POLICIES.filter((p) => {
    const text = `${p.title} ${p.text}`.toLowerCase();
    return words.some((w) => w.length > 3 && text.includes(w));
  });
  return hits.length > 0 ? hits : [...POLICIES];
}

/** Looks up an order by id. */
export const lookupOrder = recordTool("lookup_order", lookupOrderImpl);

/** Refunds an order in full. */
export const issueRefund = recordTool("issue_refund", issueRefundImpl);

/** Finds the store policies relevant to a query. */
export const searchPolicies = recordTool("search_policies", searchPoliciesImpl);
