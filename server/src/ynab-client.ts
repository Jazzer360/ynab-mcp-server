type JsonObject = Record<string, unknown>;

const API_BASE = "https://api.ynab.com/v1";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean {
  return value === true;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function money(record: JsonObject, field: string): number {
  const currency = numeric(record[`${field}_currency`]);
  if (currency !== undefined) return currency;
  const milliunits = numeric(record[field]);
  return milliunits === undefined ? 0 : milliunits / 1000;
}

function formatted(record: JsonObject, field: string): string | undefined {
  return text(record[`${field}_formatted`]);
}

function hasMoney(record: JsonObject, field: string): boolean {
  return numeric(record[`${field}_currency`]) !== undefined || numeric(record[field]) !== undefined;
}

function assertDate(value: string, name: string): void {
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be an ISO date in YYYY-MM-DD format`);
  }
}

function assertRange(sinceDate: string, untilDate: string): void {
  assertDate(sinceDate, "since_date");
  assertDate(untilDate, "until_date");
  if (sinceDate > untilDate) throw new Error("since_date must not be after until_date");
  const days = (Date.parse(`${untilDate}T00:00:00Z`) - Date.parse(`${sinceDate}T00:00:00Z`)) / 86_400_000;
  if (days > 730) throw new Error("A single query may cover at most 730 days");
}

function monthSequence(startMonth: string, endMonth: string): string[] {
  if (!MONTH_PATTERN.test(startMonth) || !MONTH_PATTERN.test(endMonth) || startMonth > endMonth) {
    throw new Error("Month range must use YYYY-MM and be in ascending order");
  }
  const values: string[] = [];
  let cursor = new Date(`${startMonth}-01T00:00:00Z`);
  const end = new Date(`${endMonth}-01T00:00:00Z`);
  while (cursor <= end) {
    values.push(cursor.toISOString().slice(0, 7));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    if (values.length > 24) throw new Error("Category history may cover at most 24 months");
  }
  return values;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

export class YnabClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listPlans() {
    const data = await this.request("/plans");
    return array(data.plans).map((plan) => ({
      id: text(plan.id),
      name: text(plan.name),
      last_modified_on: text(plan.last_modified_on),
      first_month: text(plan.first_month),
      last_month: text(plan.last_month),
    }));
  }

  async financialSnapshot(requestedPlanId?: string, month = "current") {
    const planId = await this.resolvePlanId(requestedPlanId);
    const encoded = encodeURIComponent(planId);
    const [accountsData, monthData, settingsData] = await Promise.all([
      this.request(`/plans/${encoded}/accounts`),
      this.request(`/plans/${encoded}/months/${encodeURIComponent(month)}`),
      this.request(`/plans/${encoded}/settings`).catch(() => ({})),
    ]);
    const monthRecord = object(monthData.month);
    const settings = object(object(settingsData).settings);
    const accounts = array(accountsData.accounts)
      .filter((account) => !bool(account.deleted) && !bool(account.closed))
      .map((account) => ({
        id: text(account.id),
        name: text(account.name),
        type: text(account.type),
        on_budget: bool(account.on_budget),
        balance: money(account, "balance"),
        cleared_balance: money(account, "cleared_balance"),
        uncleared_balance: money(account, "uncleared_balance"),
        balance_formatted: formatted(account, "balance"),
        note: text(account.note),
      }));
    const categories = array(monthRecord.categories)
      .filter((category) => !bool(category.deleted) && !bool(category.hidden) && !bool(category.internal))
      .map((category) => this.categoryRecord(category));
    return {
      plan_id: planId,
      month: text(monthRecord.month) ?? month,
      currency: {
        iso_code: text(settings.currency_format ? object(settings.currency_format).iso_code : undefined),
        currency_symbol: text(settings.currency_format ? object(settings.currency_format).currency_symbol : undefined),
      },
      ready_to_assign: money(monthRecord, hasMoney(monthRecord, "ready_to_assign") ? "ready_to_assign" : "to_be_budgeted"),
      income: money(monthRecord, "income"),
      assigned: money(monthRecord, hasMoney(monthRecord, "assigned") ? "assigned" : "budgeted"),
      activity: money(monthRecord, "activity"),
      age_of_money: numeric(monthRecord.age_of_money),
      accounts,
      categories,
      summary: this.summarize(accounts, categories),
    };
  }

  async categoryHistory(requestedPlanId: string | undefined, startMonth: string, endMonth: string) {
    const planId = await this.resolvePlanId(requestedPlanId);
    const months = monthSequence(startMonth, endMonth);
    const results: unknown[] = [];
    for (let index = 0; index < months.length; index += 4) {
      const batch = months.slice(index, index + 4);
      const records = await Promise.all(
        batch.map((month) => this.request(`/plans/${encodeURIComponent(planId)}/months/${month}`)),
      );
      results.push(...records);
    }
    return results.map((response) => {
      const month = object(object(response).month);
      return {
        month: text(month.month),
        income: money(month, "income"),
        assigned: money(month, hasMoney(month, "assigned") ? "assigned" : "budgeted"),
        activity: money(month, "activity"),
        ready_to_assign: money(month, hasMoney(month, "ready_to_assign") ? "ready_to_assign" : "to_be_budgeted"),
        categories: array(month.categories)
          .filter((category) => !bool(category.deleted) && !bool(category.internal))
          .map((category) => this.categoryRecord(category)),
      };
    });
  }

  async scheduledTransactions(requestedPlanId?: string) {
    const planId = await this.resolvePlanId(requestedPlanId);
    const data = await this.request(`/plans/${encodeURIComponent(planId)}/scheduled_transactions`);
    return array(data.scheduled_transactions)
      .filter((transaction) => !bool(transaction.deleted))
      .map((transaction) => ({
        id: text(transaction.id),
        date_first: text(transaction.date_first),
        date_next: text(transaction.date_next),
        frequency: text(transaction.frequency),
        amount: money(transaction, "amount"),
        amount_formatted: formatted(transaction, "amount"),
        account_id: text(transaction.account_id),
        account_name: text(transaction.account_name),
        category_id: text(transaction.category_id),
        category_name: text(transaction.category_name),
        transfer: Boolean(transaction.transfer_account_id),
      }));
  }

  async transactions(options: {
    planId?: string;
    sinceDate: string;
    untilDate: string;
    accountId?: string;
    categoryId?: string;
    includePayees?: boolean;
    includeMemos?: boolean;
    limit?: number;
  }) {
    const planId = await this.resolvePlanId(options.planId);
    assertRange(options.sinceDate, options.untilDate);
    const endpoint = options.accountId
      ? `/plans/${encodeURIComponent(planId)}/accounts/${encodeURIComponent(options.accountId)}/transactions`
      : options.categoryId
        ? `/plans/${encodeURIComponent(planId)}/categories/${encodeURIComponent(options.categoryId)}/transactions`
        : `/plans/${encodeURIComponent(planId)}/transactions`;
    const data = await this.request(endpoint, {
      since_date: options.sinceDate,
      until_date: options.untilDate,
    });
    const all = array(data.transactions).filter((transaction) => !bool(transaction.deleted));
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    return {
      plan_id: planId,
      since_date: options.sinceDate,
      until_date: options.untilDate,
      total_count: all.length,
      returned_count: Math.min(all.length, limit),
      truncated: all.length > limit,
      transactions: all.slice(0, limit).map((transaction) => this.transactionRecord(transaction, options)),
    };
  }

  async transactionChanges(options: {
    planId?: string;
    lastKnowledgeOfServer?: number;
    includePayees?: boolean;
    includeMemos?: boolean;
    limit?: number;
  }) {
    const planId = await this.resolvePlanId(options.planId);
    const initializing = options.lastKnowledgeOfServer === undefined;
    const query = initializing
      ? { since_date: new Date().toISOString().slice(0, 10) }
      : { last_knowledge_of_server: String(options.lastKnowledgeOfServer) };
    const data = await this.request(`/plans/${encodeURIComponent(planId)}/transactions`, query);
    const serverKnowledge = numeric(data.server_knowledge);
    if (serverKnowledge === undefined || !Number.isSafeInteger(serverKnowledge) || serverKnowledge < 0) {
      throw new Error("YNAB did not return a valid server_knowledge value");
    }
    const all = initializing ? [] : array(data.transactions);
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    return {
      plan_id: planId,
      initialized: initializing,
      previous_server_knowledge: options.lastKnowledgeOfServer,
      server_knowledge: serverKnowledge,
      changed_count: all.length,
      returned_count: Math.min(all.length, limit),
      truncated: all.length > limit,
      pending_transactions_included: false,
      transactions: all.slice(0, limit).map((transaction) => ({
        ...this.transactionRecord(transaction, options),
        deleted: bool(transaction.deleted),
      })),
    };
  }

  async cashFlowSummary(requestedPlanId: string | undefined, sinceDate: string, untilDate: string) {
    const raw = await this.allTransactions(requestedPlanId, sinceDate, untilDate);
    const months = new Map<string, { inflow: number; outflow: number; net: number; transaction_count: number }>();
    for (const transaction of raw.transactions) {
      const date = text(transaction.date);
      if (!date || transaction.transfer_account_id) continue;
      const amount = money(transaction, "amount");
      const entry = months.get(monthOf(date)) ?? { inflow: 0, outflow: 0, net: 0, transaction_count: 0 };
      if (amount >= 0) entry.inflow += amount;
      else entry.outflow += -amount;
      entry.net += amount;
      entry.transaction_count += 1;
      months.set(monthOf(date), entry);
    }
    return {
      plan_id: raw.planId,
      since_date: sinceDate,
      until_date: untilDate,
      months: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, values]) => ({ month, ...values })),
    };
  }

  async spendingSummary(options: {
    planId?: string;
    sinceDate: string;
    untilDate: string;
    groupBy: "month" | "category" | "category_group" | "payee";
  }) {
    const raw = await this.allTransactions(options.planId, options.sinceDate, options.untilDate);
    let categoryGroups = new Map<string, string>();
    if (options.groupBy === "category_group") {
      const data = await this.request(`/plans/${encodeURIComponent(raw.planId)}/categories`);
      for (const group of array(data.category_groups)) {
        for (const category of array(group.categories)) {
          const id = text(category.id);
          if (id) categoryGroups.set(id, text(group.name) ?? "Uncategorized");
        }
      }
    }
    const groups = new Map<string, { outflow: number; transaction_count: number }>();
    for (const transaction of raw.transactions) {
      if (transaction.transfer_account_id) continue;
      const amount = money(transaction, "amount");
      if (amount >= 0) continue;
      const key =
        options.groupBy === "month"
          ? monthOf(text(transaction.date) ?? "")
          : options.groupBy === "category"
            ? text(transaction.category_name) ?? "Uncategorized"
            : options.groupBy === "payee"
              ? text(transaction.payee_name) ?? "Unknown payee"
              : categoryGroups.get(text(transaction.category_id) ?? "") ?? "Uncategorized";
      const entry = groups.get(key) ?? { outflow: 0, transaction_count: 0 };
      entry.outflow += -amount;
      entry.transaction_count += 1;
      groups.set(key, entry);
    }
    return {
      plan_id: raw.planId,
      since_date: options.sinceDate,
      until_date: options.untilDate,
      group_by: options.groupBy,
      groups: [...groups.entries()]
        .map(([name, values]) => ({ name, ...values }))
        .sort((a, b) => b.outflow - a.outflow),
    };
  }

  private async allTransactions(requestedPlanId: string | undefined, sinceDate: string, untilDate: string) {
    const planId = await this.resolvePlanId(requestedPlanId);
    assertRange(sinceDate, untilDate);
    const data = await this.request(`/plans/${encodeURIComponent(planId)}/transactions`, {
      since_date: sinceDate,
      until_date: untilDate,
    });
    return { planId, transactions: array(data.transactions).filter((item) => !bool(item.deleted)) };
  }

  private async resolvePlanId(requested?: string): Promise<string> {
    if (requested) return requested;
    const plans = await this.listPlans();
    const ids = plans.map((plan) => plan.id).filter((id): id is string => Boolean(id));
    if (ids.length !== 1) throw new Error("Multiple YNAB plans are available; specify plan_id from list_plans");
    return ids[0]!;
  }

  private categoryRecord(category: JsonObject) {
    return {
      id: text(category.id),
      category_group_id: text(category.category_group_id),
      category_group_name: text(category.category_group_name),
      name: text(category.name),
      assigned: money(category, hasMoney(category, "assigned") ? "assigned" : "budgeted"),
      activity: money(category, "activity"),
      available: money(category, hasMoney(category, "available") ? "available" : "balance"),
      goal_type: text(category.goal_type),
      goal_target: money(category, "goal_target"),
      goal_target_month: text(category.goal_target_month),
      goal_percentage_complete: numeric(category.goal_percentage_complete),
      goal_under_funded: money(category, "goal_under_funded"),
      goal_overall_left: money(category, "goal_overall_left"),
      goal_frequency: text(category.goal_frequency),
    };
  }

  private transactionRecord(
    transaction: JsonObject,
    options: { includePayees?: boolean; includeMemos?: boolean },
  ) {
    return {
      id: text(transaction.id),
      date: text(transaction.date),
      amount: money(transaction, "amount"),
      amount_formatted: formatted(transaction, "amount"),
      account_id: text(transaction.account_id),
      account_name: text(transaction.account_name),
      category_id: text(transaction.category_id),
      category_name: text(transaction.category_name),
      cleared: text(transaction.cleared),
      approved: bool(transaction.approved),
      transfer: Boolean(transaction.transfer_account_id),
      ...(options.includePayees ? { payee_name: text(transaction.payee_name) } : {}),
      ...(options.includeMemos ? { memo: text(transaction.memo) } : {}),
    };
  }

  private summarize(
    accounts: Array<{ on_budget: boolean; type: string | undefined; balance: number }>,
    categories: Array<{ available: number }>,
  ) {
    const creditTypes = new Set(["creditCard", "lineOfCredit", "otherLiability", "mortgage"]);
    const onPlanCash = accounts
      .filter((account) => account.on_budget && !creditTypes.has(account.type ?? ""))
      .reduce((sum, account) => sum + account.balance, 0);
    const liabilities = accounts
      .filter((account) => creditTypes.has(account.type ?? "") || account.balance < 0)
      .reduce((sum, account) => sum + Math.min(account.balance, 0), 0);
    return {
      on_plan_cash: onPlanCash,
      liabilities: Math.abs(liabilities),
      positive_category_availability: categories.reduce((sum, category) => sum + Math.max(category.available, 0), 0),
      overspending: Math.abs(categories.reduce((sum, category) => sum + Math.min(category.available, 0), 0)),
    };
  }

  private async request(path: string, query?: Record<string, string>): Promise<JsonObject> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "User-Agent": "financial-analysis-for-ynab/0.2",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("YNAB authorization is invalid or expired");
      if (response.status === 429) throw new Error("YNAB rate limit reached; retry later");
      throw new Error(`YNAB API request failed with status ${response.status}`);
    }
    const payload = object(await response.json());
    return object(payload.data);
  }
}
