# Restock playbook

The job: bring every item that is **below its minimum** up to its target, prove it, and report.

## Procedure

1. **List first.** Call the list once and write down every item as `id · qty · min · target`.
2. **Decide before acting.** Mark an item LOW only when `qty < min` (strictly less). `qty == min`
   is NOT low. Check every row — the ones that are only a little short are the easy ones to miss.
3. **Update only the LOW items**, one update per item, with exactly `qty = target` and
   `status = "reordered"`. Never touch an item that is not low. Keep every ticket you get back.
4. **Verify before confirming.** Read the summary: `low` must be 0. If it is not, list again,
   re-check the rule, and update the ones you missed. Do not restock anything that is not low.
5. **Confirm** with the complete set of tickets. A refusal names a count, not the items: go back
   to step 4 rather than guessing.
6. **Report from the server.** Read the summary again and report its `totalQty` — do not sum by
   hand. The `changed` list is exactly the ids you updated.

## Pitfalls

- Skipping an item because `qty` looked close enough to `min`.
- Restocking items that were never low after a refused confirm.
- Reporting a total you computed instead of the one the server reports.
- Confirming with some of the tickets, or before the last update returned.
