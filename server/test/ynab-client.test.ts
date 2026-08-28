import { describe, expect, it, vi } from "vitest";
import { YnabClient } from "../src/ynab-client.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("read-only YNAB client", () => {
  it("keeps account cash, category commitments, and liabilities separate", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ plans: [{ id: "11111111-1111-4111-8111-111111111111", name: "Plan" }] }))
      .mockResolvedValueOnce(jsonResponse({ accounts: [
        { id: "a", name: "Checking", type: "checking", on_budget: true, closed: false, balance_currency: 10000 },
        { id: "b", name: "Card", type: "creditCard", on_budget: true, closed: false, balance_currency: -1500 },
      ] }))
      .mockResolvedValueOnce(jsonResponse({ month: {
        month: "2026-08-01",
        ready_to_assign_currency: 200,
        income_currency: 5000,
        assigned_currency: 4700,
        activity_currency: -4200,
        categories: [
          { id: "c", name: "Emergency Fund", category_group_name: "Savings", available_currency: 6000 },
          { id: "d", name: "Groceries", category_group_name: "Living", available_currency: -50 },
        ],
      } }))
      .mockResolvedValueOnce(jsonResponse({ settings: { currency_format: { iso_code: "USD", currency_symbol: "$" } } }));

    const snapshot = await new YnabClient("token", fetchMock).financialSnapshot();
    expect(snapshot.summary).toEqual({
      on_plan_cash: 10000,
      liabilities: 1500,
      positive_category_availability: 6000,
      overspending: 50,
    });
    expect(snapshot.ready_to_assign).toBe(200);
    expect(snapshot.currency.iso_code).toBe("USD");
  });

  it("excludes transfers from cash-flow totals", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ plans: [{ id: "11111111-1111-4111-8111-111111111111", name: "Plan" }] }))
      .mockResolvedValueOnce(jsonResponse({ transactions: [
        { date: "2026-07-01", amount_currency: 5000, deleted: false },
        { date: "2026-07-02", amount_currency: -1000, deleted: false },
        { date: "2026-07-03", amount_currency: -1200, transfer_account_id: "other", deleted: false },
      ] }));
    const summary = await new YnabClient("token", fetchMock).cashFlowSummary(undefined, "2026-07-01", "2026-07-31");
    expect(summary.months).toEqual([{ month: "2026-07", inflow: 5000, outflow: 1000, net: 4000, transaction_count: 2 }]);
  });

  it("uses server knowledge to return backdated transaction changes and deletions", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ transactions: [{ id: "ignored-on-baseline" }], server_knowledge: 40 }))
      .mockResolvedValueOnce(jsonResponse({ transactions: [
        {
          id: "posted-later",
          date: "2026-08-18",
          amount_currency: -16.35,
          account_name: "Card",
          category_name: "Shopping",
          payee_name: "Amazon",
          cleared: "uncleared",
          approved: false,
          deleted: false,
        },
        {
          id: "deleted-later",
          date: "2026-08-17",
          amount_currency: -5.11,
          deleted: true,
        },
      ], server_knowledge: 44 }));

    const client = new YnabClient("token", fetchMock);
    const planId = "11111111-1111-4111-8111-111111111111";
    const baseline = await client.transactionChanges({ planId, includePayees: true });
    expect(baseline).toMatchObject({ initialized: true, server_knowledge: 40, changed_count: 0 });

    const changes = await client.transactionChanges({ planId, lastKnowledgeOfServer: baseline.server_knowledge, includePayees: true });
    expect(changes).toMatchObject({
      initialized: false,
      previous_server_knowledge: 40,
      server_knowledge: 44,
      changed_count: 2,
      pending_transactions_included: false,
    });
    expect(changes.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "posted-later", date: "2026-08-18", payee_name: "Amazon", deleted: false }),
      expect.objectContaining({ id: "deleted-later", deleted: true }),
    ]));
    expect(fetchMock.mock.calls[1]?.[0].toString()).toContain("last_knowledge_of_server=40");
  });
});
