# Financial Analysis Framework

## Core measures

- **Net account position:** assets minus liabilities visible in the selected YNAB plan. Label it incomplete when material off-plan items may exist.
- **Protected category funds:** positive category availability that the user does not intend to reassign.
- **Purchase-ready funds:** the purchase category plus categories the user explicitly agrees to reassign. Never infer willingness from a high balance.
- **Typical monthly inflow/outflow:** prefer the median of complete months when one-time events make the mean misleading; show both when the difference is material.
- **Monthly surplus:** ordinary inflow minus ordinary outflow, excluding transfers and clearly identified one-time items.
- **Essential runway:** protected liquid reserves divided by typical essential monthly outflow.
- **Debt service:** scheduled or observed required debt payments, separated from discretionary extra payments when identifiable.

## Classification tests

Evaluate all applicable tests; no single ratio determines affordability.

1. **Current-plan integrity:** no new overspending or unfunded current obligations after the purchase.
2. **Near-term integrity:** known obligations and targets remain funded over 3, 6, and 12 months.
3. **Reserve integrity:** the user's stated emergency floor remains intact. If none is stated, show 3- and 6-month reference cases without treating either as a mandate.
4. **Cash-flow capacity:** normal monthly surplus covers added recurring cost with room for observed variability.
5. **Debt resilience:** payments remain manageable under the conservative case and do not depend on revolving credit-card debt.
6. **Timing resilience:** the result does not depend on uncertain sale proceeds, bonuses, reimbursements, or income arriving exactly on time.

## Scenario assumptions

Use user-provided assumptions first. If a conservative case is needed and the user has not supplied one, choose simple, visible assumptions grounded in observed variability—for example lower income or higher essential costs—and state them before calculating. Do not silently apply a universal percentage.

For financing, report:

- Amount financed.
- Payment and term.
- Total interest and fees when APR and amortization inputs are sufficient.
- Added monthly ownership costs.
- Difference in post-purchase liquidity versus cash.
- Whether retained cash is truly protected or merely postpones an unaffordable cost.

## Data-quality checks

- Flag unreconciled or stale accounts when the connector exposes that information.
- Exclude incomplete current months from historical averages unless clearly labeled.
- Investigate unusually large inflows/outflows before treating them as recurring.
- Avoid double-counting credit-card purchases and later card payments.
- Avoid treating transfers as spending or income.
- Note categories whose names do not reveal whether spending is essential; ask the user to classify only those that materially affect the conclusion.

## Decision language

State what would make the conclusion wrong. Prefer statements such as “This fits if X remains true” over certainty. When results are close to a threshold, show the sensitivity instead of rounding into a stronger conclusion.
