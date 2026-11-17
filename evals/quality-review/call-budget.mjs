export function callBudget(value = 0) {
  const max = Number(value);
  if (!Number.isSafeInteger(max) || max < 0) throw new Error('invalid --max-calls');
  return { max, used: 0 };
}
export function takeCall(budget) {
  if (budget.used >= budget.max) throw new Error('--max-calls exhausted (explicit cap required for uncached calls)');
  budget.used++;
}
export function planCalls(planned, value, dryRun = false) {
  const budget = callBudget(value);
  console.log(`Planned model calls (maximum including retries): ${planned}`);
  if ((value !== undefined || !dryRun) && planned > budget.max) throw new Error('Planned calls exceed --max-calls (explicit cap required for uncached calls)');
  return budget;
}
