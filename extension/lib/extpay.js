/**
 * ExtPay payment integration for Omni-Context Pro.
 *
 * Bridges the ExtPay payment service to FeatureGate — when a user pays or
 * starts a 7-day Pro trial, Pro features are unlocked via
 * FeatureGate.setPro(true). On startup, checks if the user already has an
 * active subscription or active trial and restores Pro status.
 *
 * Must be imported in the background service worker so that startBackground()
 * registers the ExtPay content script listeners for payment flow.
 */

import ExtPay from './ExtPay.esm.js';
import { FeatureGate } from './feature-gates.js';
import { errorLogger } from './error-logger.js';

const extpay = ExtPay('omnicontext');
extpay.startBackground();

/**
 * Plan nicknames configured in ExtensionPay/Stripe. These are the public-facing
 * launch variants (variant A). Future A/B price tests can add new nicknames
 * here without touching call sites.
 */
export const PRO_PLANS = Object.freeze({
  MONTHLY_A: 'pro_monthly_399',
  ANNUAL_A: 'pro_yearly_29',
  MONTHLY_B: 'pro_monthly_499',
  ANNUAL_B: 'pro_yearly_39',
  FOUNDER_LIFETIME: 'founder_lifetime_49',
});

/**
 * Default plan set shown to users. Maps a billing cadence to the current
 * production plan nickname. Change these values to switch A/B variants.
 */
export const DEFAULT_PLANS = Object.freeze({
  monthly: PRO_PLANS.MONTHLY_A,
  annual: PRO_PLANS.ANNUAL_A,
});

/**
 * Trial configuration. The '7-day Pro' string is passed to ExtPay's hosted
 * trial page and used locally to calculate active-trial eligibility.
 */
export const TRIAL_CONFIG = Object.freeze({
  periodLabel: '7-day Pro',
  durationDays: 7,
});

/**
 * Determine whether a given ExtPay user object represents an active Pro
 * subscription or an active trial.
 *
 * Existing paid users keep Pro access. Trial users get Pro for 7 days from
 * trialStartedAt. Both are evaluated against the same FeatureGate gates.
 *
 * @param {object|null} user
 * @returns {{ isPro: boolean, isPaid: boolean, isTrialActive: boolean, trialDaysLeft: number|null, trialExpiresAt: string|null }}
 */
export function evaluateProStatus(user) {
  const now = Date.now();
  const isPaid = !!(user && user.paid);

  let isTrialActive = false;
  let trialDaysLeft = null;
  let trialExpiresAt = null;
  if (user && user.trialStartedAt) {
    const started = user.trialStartedAt instanceof Date
      ? user.trialStartedAt.getTime()
      : new Date(user.trialStartedAt).getTime();
    if (!Number.isNaN(started)) {
      const elapsedMs = now - started;
      const durationMs = TRIAL_CONFIG.durationDays * 24 * 60 * 60 * 1000;
      const expiresAtMs = started + durationMs;
      trialExpiresAt = new Date(expiresAtMs).toISOString();
      isTrialActive = elapsedMs >= 0 && now < expiresAtMs;
      if (isTrialActive) {
        trialDaysLeft = Math.max(
          0,
          Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000))
        );
      }
    }
  }

  return { isPro: isPaid || isTrialActive, isPaid, isTrialActive, trialDaysLeft, trialExpiresAt };
}

// Bridge ExtPay payment events to FeatureGate — activates Pro immediately on payment
extpay.onPaid.addListener((user) => {
  errorLogger.log('extpay:onPaid', `Payment confirmed for user: ${user?.email || 'unknown'}`);
  FeatureGate.setPro(true, { source: 'paid' });
});

// Bridge ExtPay trial-start events to FeatureGate — activates Pro immediately on trial start
extpay.onTrialStarted.addListener((user) => {
  const status = evaluateProStatus(user);
  const fallbackTrialExpiresAt = new Date(
    Date.now() + TRIAL_CONFIG.durationDays * 24 * 60 * 60 * 1000
  ).toISOString();
  errorLogger.log('extpay:onTrialStarted', `Trial started for user: ${user?.email || 'unknown'}`);
  FeatureGate.setPro(true, {
    source: 'trial',
    trialExpiresAt: status.trialExpiresAt || fallbackTrialExpiresAt,
  });
});

// Check on extension startup if user already has an active subscription or trial
extpay.getUser().then((user) => {
  const status = evaluateProStatus(user);
  if (status.isPro) {
    FeatureGate.setPro(true, {
      source: status.isPaid ? 'paid' : 'trial',
      trialExpiresAt: status.isTrialActive ? status.trialExpiresAt : null,
    });
    errorLogger.log(
      'extpay:getUser',
      `Pro restored — paid: ${status.isPaid}, trialActive: ${status.isTrialActive}`
    );
  } else if (user && user.trialStartedAt && !status.isTrialActive && !status.isPaid) {
    FeatureGate.setPro(false);
    errorLogger.log('extpay:getUser', 'Stored trial expired; Pro access disabled');
  }
}).catch((err) => {
  // Non-critical — user might not be logged in yet or network may be unavailable.
  // Log for debugging payment flow issues rather than swallowing silently.
  errorLogger.log('extpay:getUser', err);
});

export { extpay };

/**
 * Open the ExtPay payment page for the user to purchase or manage their Pro subscription.
 * Triggers ExtPay's hosted payment flow in a new tab.
 *
 * @param {string} [planNickname]  Optional ExtensionPay plan nickname (e.g.
 *   PRO_PLANS.MONTHLY_A). Uses ExtPay's default plan list when omitted.
 * @returns {Promise<void>} Resolves when the payment page has been opened.
 * @throws {Error} If ExtPay fails to open the payment page (e.g., network error).
 */
export async function openPaymentPage(planNickname) {
  await extpay.openPaymentPage(planNickname);
}

/**
 * Open the ExtPay trial page for a 7-day Pro trial.
 * @returns {Promise<void>}
 */
export async function openTrialPage() {
  await extpay.openTrialPage(TRIAL_CONFIG.periodLabel);
}
