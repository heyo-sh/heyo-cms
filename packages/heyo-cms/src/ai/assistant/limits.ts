/**
 * Limits enforced in code, shared with the read-only panel description.
 * A budget the model can talk itself out of is not a budget.
 */
export const assistantLimits = {
  maxTurns: 8,
  maxToolCalls: 16,
  timeoutMs: 90_000,
} as const;
