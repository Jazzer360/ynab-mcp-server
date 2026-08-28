# YNAB Read-Only Data Contract

Use the connector's semantic equivalents when tool names differ. If a required capability is absent, report the missing capability instead of substituting a write tool or inventing data.

## Required tools

- `connection_status`: Confirm that the current user has a valid read-only YNAB connection.
- `list_plans`: Return plan identifiers, names, and modification dates without financial details.
- `get_financial_snapshot`: Return one plan's open accounts, current-month category state, Ready to Assign, plan currency, and summary totals.
- `get_category_history`: Return monthly assigned, activity, and available amounts by category for an explicit month range.
- `get_cash_flow_summary`: Return monthly inflows, outflows, transfers excluded from spending, and net cash flow for an explicit date range.
- `get_spending_summary`: Aggregate outflows by month, category, category group, or payee for an explicit date range.
- `get_scheduled_transactions`: Return scheduled inflows and outflows needed for near-term obligations.
- `get_transactions`: Return bounded transaction detail for an explicit date range and optional account/category filters.
- `get_transaction_changes`: Return settled transactions posted, edited, or deleted since the previous successful call for a stable `checkpoint_name`, together with the new YNAB `server_knowledge` value. The connector owns checkpoint persistence; callers must not try to remember or manufacture the numeric cursor.

## Privacy defaults

- Default `include_payees` to `false` for snapshots and category summaries.
- Default `include_memos` to `false` everywhere.
- Exclude deleted entities unless they are required to reconcile historical totals.
- Return only fields used by the analysis; never return import identifiers, authentication data, or raw HTTP headers.
- Bound transaction results and return an aggregate plus truncation metadata when the result is large.
- Keep separate named checkpoints for separate recurring workflows so an interactive query cannot consume another workflow's changes.

## Monetary and date rules

- Prefer YNAB decimal currency fields when supplied by the API.
- When only milliunits are available, convert with `currency = milliunits / 1000` exactly once.
- Preserve the plan's ISO currency code and do not assume USD.
- Use `/plans` resource paths from the current YNAB API.
- Always send explicit `since_date` and `until_date` values for transaction retrieval.
- Date bounds are not a substitute for delta tracking: a newly imported transaction can retain an older transaction date. Use `get_transaction_changes` for “since the last run” questions.
- Treat transfers separately from income and spending.
- Treat credit-card balances and credit-card payment-category availability as related but distinct measures.
- YNAB transaction endpoints exclude pending transactions. Never imply that delta tracking includes pending activity.

## Snapshot distinctions

Keep these values separate:

- Open on-plan cash accounts.
- Open credit-card and other liability balances.
- Tracking/off-plan assets and liabilities.
- Ready to Assign.
- Sum of positive category availability.
- Overspent categories.
- Scheduled and target-based near-term needs.

Do not present their sum as a single “spendable” number.
