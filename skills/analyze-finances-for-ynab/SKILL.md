---
name: analyze-finances-for-ynab
description: Analyze a user's live YNAB plan to assess financial health, cash-flow resilience, category funding, debt, reserves, and the affordability of a major purchase. Use for YNAB-based financial checkups, purchase decisions, cash-versus-financing comparisons, spending and income trends, emergency-fund analysis, or questions about whether a proposed expense fits safely. Require a connected read-only YNAB MCP server; do not use for editing YNAB data, executing transactions, choosing investments, tax advice, or legal advice.
---

# Analyze Finances for YNAB

Use connected YNAB data to produce a decision-oriented financial analysis without changing the user's plan. Treat category assignments as commitments: an account balance is not automatically available for a purchase.

## Guardrails

- Use only read-only YNAB tools. Never create, update, move, approve, or delete YNAB data.
- Never ask the user to paste an access token, authorization code, client secret, or refresh token into chat.
- Never reveal authentication headers, connection metadata, or raw tool errors containing credentials.
- Minimize sensitive transaction detail. Request payee names only when needed and memos only after explicit user agreement.
- Label observed YNAB facts, calculations, user-provided facts, and assumptions separately.
- Do not imply that YNAB contains every asset, liability, income source, tax obligation, or insurance cost.
- Provide analysis and tradeoffs, not a guarantee or personalized investment, tax, or legal advice.

## Choose the Workflow

1. For a broad financial checkup, follow **Financial Health Review**.
2. For a proposed purchase, follow **Major Purchase Review**.
3. For a narrow question, retrieve only the minimum data needed and apply the relevant parts of the framework.

Read [references/ynab-data-contract.md](references/ynab-data-contract.md) before the first live-data call in a conversation. Read [references/analysis-framework.md](references/analysis-framework.md) for a full health or purchase analysis.

## Establish the Data Boundary

1. Confirm the read-only connector is authenticated.
2. List available plans when no default plan is established. Ask the user to select when multiple plausible plans exist; do not guess from names alone.
3. State the analysis date and requested lookback period.
4. Use explicit start and end dates for every transaction query.
5. Start with aggregated snapshots and summaries. Retrieve individual transactions only to investigate a material finding.
6. Ask about material items outside YNAB only after inspecting what the connected plan contains.
7. For recurring spending checks, call `get_transaction_changes` with a stable, workflow-specific `checkpoint_name`. Treat its first call as baseline initialization, not evidence of no recent spending. Use current summaries for spending pace and the change feed only for newly posted or edited activity.
8. State that pending transactions are unavailable through the YNAB API and are excluded from every connector result.

## Financial Health Review

Retrieve, in this order:

1. Current plan snapshot, open accounts, current-month category state, and Ready to Assign.
2. Monthly category history and cash-flow summaries for the last 12 complete months when available.
3. Scheduled transactions and near-term targets or underfunded categories.
4. Targeted transaction detail only for anomalies or unclear aggregates.

Then evaluate:

- Liquidity, separated into on-plan cash, tracking assets, and debt.
- Money already committed to categories and near-term obligations.
- Overspending, underfunding, and credit-card payment-category mismatches.
- Typical monthly inflow, essential outflow, discretionary outflow, and variability.
- Emergency runway using both the user's chosen reserve floor and clearly labeled 3- and 6-month reference cases when no floor is supplied.
- Debt balances and required payments visible in YNAB.
- Data gaps that could materially change the conclusion.

Do not call positive bank balances “available to spend” unless the corresponding category commitments have been accounted for.

## Major Purchase Review

After the health review, gather the minimum missing purchase facts:

- Purchase date and all-in cash price.
- Down payment, trade-in or sale proceeds, loan amount, APR, term, and fees when financing is considered.
- Added recurring costs such as insurance, energy or fuel, maintenance, subscriptions, registration, and taxes.
- Any existing expense or debt payment the purchase replaces.
- Categories the user is willing to reassign and the minimum reserve they want protected.

Model at least these cases when applicable:

1. Cash purchase.
2. Proposed financing.
3. A conservative stress case with explicitly stated assumptions.

For each case, calculate:

- Immediate draw from genuinely uncommitted or intentionally reassigned funds.
- Category commitments disturbed by the purchase.
- Post-purchase protected reserves and essential-expense runway.
- New monthly fixed cost and effect on typical monthly surplus.
- Near-term funding gaps over the next 3, 6, and 12 months.
- Total financing cost when the needed terms are known.

Classify the result as one of:

- **Fits safely**: obligations remain funded, the chosen reserve floor remains intact, and recurring costs fit ordinary cash flow.
- **Fits with conditions**: viable only after named reallocations, a smaller purchase, delayed timing, or another concrete condition.
- **High strain**: the purchase consumes protected reserves, creates persistent monthly deficits, or relies on optimistic assumptions.
- **Insufficient data**: a material unknown prevents a responsible conclusion.

Never base the classification on account balance alone.

## Output Format

Lead with the decision and confidence level, followed by:

1. **Current position** — liquidity, commitments, debt, monthly cash flow, and runway.
2. **What the purchase changes** — immediate and recurring effects.
3. **Scenario comparison** — cash, financing, and stress case in a compact table.
4. **Binding constraints** — the two or three factors most likely to cause trouble.
5. **Conditions for safety** — concrete thresholds or actions that change the classification.
6. **Unknowns** — missing facts that could materially change the result.

Use currency values and percentages consistently. Show calculation definitions for important derived figures, but avoid dumping raw transaction data.
