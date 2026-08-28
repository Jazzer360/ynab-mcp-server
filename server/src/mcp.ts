import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { hashToken } from "./crypto.js";
import type { OAuthService } from "./oauth.js";
import type { RecordStore } from "./store.js";
import { YnabClient } from "./ynab-client.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const planId = z.string().uuid().optional().describe("YNAB plan ID. Omit only when the account has exactly one plan.");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const checkpointName = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe("Stable lowercase name for this consumer, such as daily-spending-coach. Reuse the same name on every run.");

interface TransactionChangeCheckpoint {
  grantId: string;
  planId: string;
  checkpointName: string;
  serverKnowledge: number;
  updatedAt: number;
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "The read-only YNAB request failed";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function createYnabMcpServer(
  oauth: OAuthService,
  store: RecordStore,
  grantId: string,
  fetchImpl: typeof fetch = fetch,
): McpServer {
  const server = new McpServer({ name: "financial-analysis-for-ynab", version: "0.2.0" });

  const withClient = async <T extends Record<string, unknown>>(operation: (client: YnabClient) => Promise<T>) => {
    try {
      const accessToken = await oauth.getYnabAccessToken(grantId);
      return result(await operation(new YnabClient(accessToken, fetchImpl)));
    } catch (error) {
      return toolError(error);
    }
  };

  server.registerTool(
    "get_transaction_changes",
    {
      title: "Recent YNAB transaction changes — persistent checkpoint",
      description: "Read recent transactions and transaction changes since last check using YNAB delta synchronization and a persistent checkpoint. The first call establishes a baseline and returns no historical transactions; later calls return settled transactions posted, edited, or deleted since that checkpoint. Pending transactions are not exposed by the public YNAB API.",
      inputSchema: z.object({
        plan_id: planId,
        checkpoint_name: checkpointName,
        include_payees: z.boolean().default(false),
        include_memos: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(200),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ plan_id, checkpoint_name, include_payees, include_memos, limit }) =>
      withClient(async (client) => {
        const plans = plan_id ? [{ id: plan_id }] : await client.listPlans();
        const resolvedPlanId = plan_id ?? (plans.length === 1 ? plans[0]?.id : undefined);
        if (!resolvedPlanId) {
          throw new Error("Multiple YNAB plans are available; specify plan_id from list_plans");
        }

        const checkpointId = hashToken(`${grantId}:${resolvedPlanId}:${checkpoint_name}`);
        const checkpoint = await store.get<TransactionChangeCheckpoint>("transaction_change_checkpoints", checkpointId);
        if (checkpoint && (
          checkpoint.grantId !== grantId
          || checkpoint.planId !== resolvedPlanId
          || checkpoint.checkpointName !== checkpoint_name
        )) {
          throw new Error("Stored transaction-change checkpoint does not match the authenticated grant and plan");
        }

        const changes = await client.transactionChanges({
          planId: resolvedPlanId,
          ...(checkpoint ? { lastKnowledgeOfServer: checkpoint.serverKnowledge } : {}),
          includePayees: include_payees,
          includeMemos: include_memos,
          limit,
        });

        const checkpointAdvanced = !changes.truncated;
        if (checkpointAdvanced) {
          await store.put<TransactionChangeCheckpoint>("transaction_change_checkpoints", checkpointId, {
            grantId,
            planId: resolvedPlanId,
            checkpointName: checkpoint_name,
            serverKnowledge: changes.server_knowledge,
            updatedAt: Math.floor(Date.now() / 1000),
          });
        }

        return {
          checkpoint_name,
          checkpoint_advanced: checkpointAdvanced,
          ...changes,
          note: changes.initialized
            ? "Change tracking was initialized. No historical transactions are reported on the baseline call."
            : changes.truncated
              ? "The transaction-change delta exceeded the requested limit, so the persistent checkpoint was not advanced. Retry with a higher limit to avoid skipping changes."
              : "Includes settled YNAB transaction changes since the prior successful check for this persistent checkpoint; pending transactions remain unavailable.",
        };
      }),
  );

  server.registerTool(
    "connection_status",
    {
      title: "YNAB connection status",
      description: "Confirm that the current session has a valid read-only YNAB authorization.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => withClient(async (client) => ({ authenticated: true, access: "read-only", plans: await client.listPlans() })),
  );

  server.registerTool(
    "list_plans",
    {
      title: "List YNAB plans",
      description: "List the YNAB plans available to the connected user without returning financial details.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => withClient(async (client) => ({ plans: await client.listPlans() })),
  );

  server.registerTool(
    "get_financial_snapshot",
    {
      title: "Get financial snapshot",
      description: "Read open accounts and the selected month's category state, Ready to Assign, targets, and summary totals.",
      inputSchema: z.object({
        plan_id: planId,
        month: z.union([z.literal("current"), month]).default("current"),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id, month: selectedMonth }) =>
      withClient(async (client) => client.financialSnapshot(plan_id, selectedMonth)),
  );

  server.registerTool(
    "get_category_history",
    {
      title: "Get category history",
      description: "Read monthly assigned, activity, available, and target amounts by category for up to 24 months.",
      inputSchema: z.object({ plan_id: planId, start_month: month, end_month: month }),
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id, start_month, end_month }) =>
      withClient(async (client) => ({
        plan_id,
        start_month,
        end_month,
        months: await client.categoryHistory(plan_id, start_month, end_month),
      })),
  );

  server.registerTool(
    "get_cash_flow_summary",
    {
      title: "Get cash-flow summary",
      description: "Aggregate non-transfer inflows, outflows, and net cash flow by month for an explicit date range.",
      inputSchema: z.object({ plan_id: planId, since_date: date, until_date: date }),
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id, since_date, until_date }) =>
      withClient(async (client) => client.cashFlowSummary(plan_id, since_date, until_date)),
  );

  server.registerTool(
    "get_spending_summary",
    {
      title: "Get spending summary",
      description: "Aggregate non-transfer outflows by month, category, category group, or payee for an explicit date range.",
      inputSchema: z.object({
        plan_id: planId,
        since_date: date,
        until_date: date,
        group_by: z.enum(["month", "category", "category_group", "payee"]),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id, since_date, until_date, group_by }) =>
      withClient(async (client) => client.spendingSummary({
        ...(plan_id ? { planId: plan_id } : {}),
        sinceDate: since_date,
        untilDate: until_date,
        groupBy: group_by,
      })),
  );

  server.registerTool(
    "get_scheduled_transactions",
    {
      title: "Get scheduled transactions",
      description: "Read scheduled YNAB inflows and outflows without returning payee names or memos.",
      inputSchema: z.object({ plan_id: planId }),
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id }) =>
      withClient(async (client) => ({ plan_id, scheduled_transactions: await client.scheduledTransactions(plan_id) })),
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Get bounded transaction detail",
      description: "Read bounded transaction detail for an explicit date range. Payees and memos are excluded unless specifically requested.",
      inputSchema: z.object({
        plan_id: planId,
        since_date: date,
        until_date: date,
        account_id: z.string().uuid().optional(),
        category_id: z.string().uuid().optional(),
        include_payees: z.boolean().default(false),
        include_memos: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(200),
      }).refine((value) => !(value.account_id && value.category_id), {
        message: "Use either account_id or category_id, not both",
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ plan_id, since_date, until_date, account_id, category_id, include_payees, include_memos, limit }) =>
      withClient(async (client) => client.transactions({
        ...(plan_id ? { planId: plan_id } : {}),
        sinceDate: since_date,
        untilDate: until_date,
        ...(account_id ? { accountId: account_id } : {}),
        ...(category_id ? { categoryId: category_id } : {}),
        includePayees: include_payees,
        includeMemos: include_memos,
        limit,
      })),
  );

  return server;
}
