// FUNDING.md 2.1: the fixed values a P1 bounty is created with (D122 ruling 3),
// and the three categories. These are the phone's own constants, checked
// against every create response (and every resumed bounty) by
// verifyCreatedBounty.

export const CATEGORIES = ['Property', 'Retail', 'Infrastructure'] as const;
export type Category = (typeof CATEGORIES)[number];

export const FIXED_POLICY = {
  required_assurance: 1,
  eligibility_profile_id: 'BASE_V1',
  capture_radius_m: 150,
  acceptance_window_seconds: 86_400,
  completion_window_seconds: 7_200,
  challenge_window_seconds: 3_600,
} as const;

/** How the fixed values read on the form and on Review. */
export const FIXED_LABELS: readonly (readonly [string, string])[] = [
  ['Assurance', 'A1'],
  ['Capture radius', '150 m'],
  ['Open for', '24 hours'],
  ['Time to complete', '2 hours'],
  ['Review window', '1 hour'],
];

export const TITLE_MAX = 120;
export const PROMPT_MAX = 500;
export const PROMPTS_MAX = 20;
