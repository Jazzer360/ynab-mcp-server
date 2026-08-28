# Upgrade to 0.2.0: transaction-change tracking

Version 0.2.0 adds `get_transaction_changes`, a read-only YNAB tool that uses
YNAB's `server_knowledge` cursor. It reports settled transactions that were
posted, edited, or deleted after a named consumer's previous successful check,
even when their transaction dates are older than a rolling date window.

YNAB's public API does not expose pending transactions, so pending activity is
still excluded.

## Deploy from Windows PowerShell

Extract this bundle to a new folder, open PowerShell in that folder, and run:

```powershell
gcloud auth login
gcloud config set project ynab-mcp-504216

gcloud run deploy financial-analysis-for-ynab `
  --source=. `
  --project=ynab-mcp-504216 `
  --region=us-central1 `
  --quiet
```

Do not rerun the bootstrap or finalize scripts. The existing Cloud Run URL,
service account, Firestore database, secrets, and YNAB OAuth registration are
reused.

Verify the service after deployment:

```powershell
$BaseUrl = "https://financial-analysis-for-ynab-1044985604384.us-central1.run.app"
Invoke-RestMethod "$BaseUrl/health"

gcloud run services logs read financial-analysis-for-ynab `
  --project=ynab-mcp-504216 `
  --region=us-central1 `
  --limit=20
```

The health request should return a JSON object with `status` equal to `ok`.

## Refresh ChatGPT

In ChatGPT, open **Settings > Plugins > Financial Analysis for YNAB**, open the
plugin menu, and select **Refresh**. Confirm that the available actions now
include `get_transaction_changes`. The existing YNAB connection should remain
authorized because the OAuth URLs and scope have not changed.

## Initialize the daily checkpoint

Before the next scheduled run, ask ChatGPT to make one baseline call with the
same checkpoint name the task will use:

> Use Financial Analysis for YNAB. Call `get_transaction_changes` for my plan
> with checkpoint name `daily-spending-coach`, payees included, memos excluded,
> and a limit of 500. This call is only to establish the baseline.

The expected result has `initialized: true` and no historical changes. That
does not mean there was no recent spending; it means subsequent calls will
report changes after this point.

## Update the recurring task

Tell the scheduled task to use the exact checkpoint name
`daily-spending-coach` on every run. It should use `get_transaction_changes`
for the "new since last run" section, and continue using
`get_spending_summary` or the current financial snapshot for month-to-date
totals and pacing. Delta results are not a substitute for full-period totals.

Keep these rules in the task instructions:

- Describe delta results as settled transactions posted or changed since the
  prior successful run, not as transactions from a rolling calendar window.
- State that YNAB pending transactions and card-issuer pending transactions are
  unavailable.
- Treat `initialized: true` as baseline creation, not as evidence of no recent
  spending.
- If `truncated: true`, disclose that the itemized change list is incomplete.
- Do not change the checkpoint name unless intentionally starting a new
  baseline.

