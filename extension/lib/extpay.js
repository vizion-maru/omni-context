/**
 * ExtPay payment integration for Omni-Context Pro.
 *
 * Bridges the ExtPay payment service to FeatureGate — when a user pays,
 * Pro features are unlocked via FeatureGate.setPro(true). On startup,
 * checks if the user already has an active subscription and restores Pro status.
 *
 * Must be imported in the background service worker so that startBackground()
 * registers the ExtPay content script listeners for payment flow.
 */

import ExtPay from './ExtPay.esm.js';
import { FeatureGate } from './feature-gates.js';
import { errorLogger } from './error-logger.js';

const extpay = ExtPay('omnicontext');
extpay.startBackground();

// Bridge ExtPay payment events to FeatureGate — activates Pro features immediately on payment
extpay.onPaid.addListener((user) => {
  errorLogger.log('extpay:onPaid', `Payment confirmed for user: ${user?.email || 'unknown'}`);
  FeatureGate.setPro(true);
});

// Check on extension startup if user already has an active subscription
extpay.getUser().then((user) => {
  if (user && user.paid) {
    FeatureGate.setPro(true);
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
 * @returns {Promise<void>} Resolves when the payment page has been opened.
 * @throws {Error} If ExtPay fails to open the payment page (e.g., network error).
 */
export async function openPaymentPage() {
  await extpay.openPaymentPage();
}
