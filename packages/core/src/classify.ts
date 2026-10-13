import type { Effect, OperationCandidate } from '@taurus/adapter-sdk';
import type { PlatformRisk, Ratings } from './model.js';

/** Ordered from least to most risky. */
export const EFFECT_ORDER: Effect[] = ['read', 'write', 'delete', 'send', 'personal', 'account', 'payment'];

export function maxEffect(...effects: Effect[]): Effect {
  let worst: Effect = 'read';
  for (const effect of effects) {
    if (effect === 'unknown') continue;
    if (EFFECT_ORDER.indexOf(effect) > EFFECT_ORDER.indexOf(worst)) worst = effect;
  }
  return worst;
}

const PATH_RULES: { pattern: RegExp; effect: Effect }[] = [
  { pattern: /\/(billing|payments?|checkout|purchase|orders?\/[^/]+\/pay|subscriptions?|invoices?\/[^/]+\/pay)(\/|$)/i, effect: 'payment' },
  { pattern: /\/(account|password|security|2fa|mfa|sessions?|api-?keys?|tokens?)(\/|$)/i, effect: 'account' },
  { pattern: /\/(contacts?|phone|phones|emails?)(\/|$)/i, effect: 'personal' },
  { pattern: /\/(messages?|send|invites?|invitations?|share|shares|mail|notify|notifications\/send)(\/|$)/i, effect: 'send' },
];

/**
 * Fixed rules that set the minimum risk of an operation (ARCHITECTURE 7.2).
 * Based on what the operation does on the wire, never on its display name.
 */
export function ruleFloor(candidate: OperationCandidate): Effect {
  const binding = candidate.execution.binding as { method?: string; pathTemplate?: string } | null;
  const method = binding?.method?.toUpperCase();
  const path = binding?.pathTemplate ?? '';
  let floor: Effect = 'read';
  if (method === 'DELETE') floor = 'delete';
  else if (method && !['GET', 'HEAD', 'OPTIONS'].includes(method)) floor = 'write';
  else if (!method) floor = 'write'; // unknown transport: never assume read-only
  for (const rule of PATH_RULES) {
    if (rule.pattern.test(path)) {
      // Reading your own account or billing pages is still sensitive, but only writes carry the full effect.
      const effect = floor === 'read' && rule.effect !== 'personal' ? 'read' : rule.effect;
      floor = maxEffect(floor, effect);
    }
  }
  return floor;
}

function platformRiskFor(effect: Effect): PlatformRisk {
  if (effect === 'payment' || effect === 'account') return 'high';
  if (effect === 'send' || effect === 'personal') return 'medium';
  return 'low';
}

/** Rates a candidate. Adapter hints and a future classifier can raise the risk, never lower it below the rule floor. */
export function classify(candidate: OperationCandidate, classifierHint?: Effect): Ratings {
  const risk = maxEffect(ruleFloor(candidate), ...candidate.effectHints, ...(classifierHint ? [classifierHint] : []));
  const observations = candidate.evidence.observations ?? 0;
  const confidence =
    candidate.evidence.seen === 'observed' ? Math.min(0.9, 0.6 + 0.1 * Math.max(0, observations - 1)) : 0.3;
  return { risk, confidence: Number(confidence.toFixed(2)), platformRisk: platformRiskFor(risk) };
}
