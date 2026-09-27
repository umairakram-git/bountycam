// FUNDING.md 2.1 and 2.2: the create request, POST /bounties, and the
// POLICY.md 3.5 check through verifyCreatedBounty. Also the resume path of
// FUNDING.md 2.4, where the expectation is rebuilt from the fixed values and
// the response's own editable fields.

import {
  SpecError,
  decimalToBaseUnits,
  parseCoordinatePair,
  verifyCreatedBounty,
} from '@hackathon/shared';
import type { CreatedBountyExpectation, FundingArgs } from '@hackathon/shared';

import { POLICY_CLUSTER, SETTLEMENT_MINT, USDC_DECIMALS } from '../config';
import { apiGet, apiPost, errorCodeOf } from '../api/client';
import { FIXED_POLICY, PROMPTS_MAX, PROMPT_MAX, TITLE_MAX, type Category } from './defaults';

export interface CreateForm {
  readonly title: string;
  readonly category: Category;
  /** `lat, lon` as pasted (D122 ruling 2). */
  readonly location: string;
  /** A USDC amount as typed, e.g. `10` or `12.50`. */
  readonly reward: string;
  readonly prompts: readonly string[];
}

/** The verified bounty: what Review shows and what Funding builds from. */
export interface VerifiedBounty {
  readonly id: string;
  readonly expectation: CreatedBountyExpectation;
  readonly args: FundingArgs;
  /** The owner view as returned, kept for display only. */
  readonly response: unknown;
}

export type CreateOutcome =
  | { readonly ok: true; readonly bounty: VerifiedBounty }
  | { readonly ok: false; readonly message: string; readonly detail?: string };

function describeThrown(error: unknown): string {
  if (error instanceof SpecError) return error.code + ': ' + error.message;
  if (error instanceof Error) return error.name + ': ' + error.message;
  return String(error);
}

/** Form to expectation. Throws SpecError for a bad location or reward. */
export function expectationFromForm(form: CreateForm): CreatedBountyExpectation {
  const title = form.title.trim();
  if (title.length < 1 || title.length > TITLE_MAX) {
    throw new SpecError('FORM_TITLE', 'title must be 1 to ' + TITLE_MAX + ' characters');
  }
  const prompts = form.prompts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (prompts.length < 1 || prompts.length > PROMPTS_MAX) {
    throw new SpecError('FORM_PROMPTS', '1 to ' + PROMPTS_MAX + ' photo prompts are needed');
  }
  for (const p of prompts) {
    if (p.length > PROMPT_MAX) {
      throw new SpecError('FORM_PROMPT', 'a prompt is longer than ' + PROMPT_MAX + ' characters');
    }
  }
  const { lat, lon } = parseCoordinatePair(form.location);
  const reward_amount = decimalToBaseUnits(form.reward.trim(), USDC_DECIMALS);
  return {
    cluster: POLICY_CLUSTER,
    settlementMint: SETTLEMENT_MINT,
    title,
    category: form.category,
    policy: {
      ...FIXED_POLICY,
      evidence_requirements: prompts.map((prompt) => ({ prompt, required: true, type: 'PHOTO' })),
      lat,
      lon,
      reward_amount,
    },
  };
}

/** The POST /bounties body (POLICY.md 8.3): exactly four keys. */
function requestBody(idempotencyKey: string, e: CreatedBountyExpectation): unknown {
  return {
    idempotency_key: idempotencyKey,
    title: e.title,
    category: e.category,
    policy: {
      ...e.policy,
      cluster: e.cluster,
      settlement_mint: e.settlementMint,
    },
  };
}

function verified(response: unknown, expectation: CreatedBountyExpectation): CreateOutcome {
  let args: FundingArgs;
  try {
    args = verifyCreatedBounty(response, expectation);
  } catch (error: unknown) {
    return {
      ok: false,
      message: 'This bounty could not be verified and was not funded.',
      detail: describeThrown(error),
    };
  }
  const id = (response as { id: string }).id;
  return { ok: true, bounty: { id, expectation, args, response } };
}

/**
 * FUNDING.md 2.2: create, then verify against exactly what was sent.
 * `idempotencyKey` is fresh per form submission and reused on a retry.
 */
export async function createAndVerify(
  token: string,
  idempotencyKey: string,
  expectation: CreatedBountyExpectation,
): Promise<CreateOutcome> {
  let result;
  try {
    result = await apiPost(token, '/bounties', requestBody(idempotencyKey, expectation));
  } catch (error: unknown) {
    return { ok: false, message: 'Could not reach the server.', detail: describeThrown(error) };
  }
  if (result.status !== 201) {
    return {
      ok: false,
      message: 'The server did not accept this bounty.',
      detail: 'HTTP ' + String(result.status) + ' ' + String(errorCodeOf(result.body)),
    };
  }
  return verified(result.body, expectation);
}

/**
 * FUNDING.md 2.4: resume a DRAFT created earlier. The expectation is the fixed
 * values, the environment, and the response's own editable fields; Review is
 * where the requester confirms those.
 */
export async function loadAndVerify(token: string, id: string): Promise<CreateOutcome> {
  let result;
  try {
    result = await apiGet(token, '/bounties/' + id);
  } catch (error: unknown) {
    return { ok: false, message: 'Could not reach the server.', detail: describeThrown(error) };
  }
  if (result.status !== 200) {
    return {
      ok: false,
      message: 'This bounty could not be loaded.',
      detail: 'HTTP ' + String(result.status) + ' ' + String(errorCodeOf(result.body)),
    };
  }
  const body = result.body as {
    title?: unknown;
    category?: unknown;
    policy?: {
      lat?: unknown;
      lon?: unknown;
      reward_amount?: unknown;
      evidence_requirements?: unknown;
    };
  };
  const p = body.policy ?? {};
  const items = Array.isArray(p.evidence_requirements)
    ? (p.evidence_requirements as unknown[])
    : [];
  const expectation: CreatedBountyExpectation = {
    cluster: POLICY_CLUSTER,
    settlementMint: SETTLEMENT_MINT,
    title: String(body.title),
    category: String(body.category),
    policy: {
      ...FIXED_POLICY,
      evidence_requirements: items.map((item) => {
        const r = (item ?? {}) as { prompt?: unknown; required?: unknown; type?: unknown };
        return { prompt: String(r.prompt), required: r.required === true, type: String(r.type) };
      }),
      lat: String(p.lat),
      lon: String(p.lon),
      reward_amount: String(p.reward_amount),
    },
  };
  return verified(result.body, expectation);
}

/** Base units to a USDC display string, by string arithmetic only. */
export function formatUsdc(baseUnits: bigint): string {
  const s = baseUnits.toString().padStart(USDC_DECIMALS + 1, '0');
  const whole = s.slice(0, s.length - USDC_DECIMALS);
  const fraction = s.slice(s.length - USDC_DECIMALS).replace(/0+$/, '');
  return fraction.length === 0 ? whole : whole + '.' + fraction;
}
