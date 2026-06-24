import ExtPay from './ExtPay.esm.js';
import { FeatureGate } from './feature-gates.js';

const extpay = ExtPay('omnicontext');
extpay.startBackground();

// CRITICAL: Bridge ExtPay payment to FeatureGate
// When user pays via ExtPay, activate Pro features
extpay.onPaid.addListener((user) => {
  console.log('[ExtPay] Payment confirmed for user:', user.email);
  FeatureGate.setPro(true);
});

// Also check on extension startup if user already paid previously
extpay.getUser().then((user) => {
  if (user && user.paid) {
    FeatureGate.setPro(true);
  }
}).catch(() => {
  // Silent — user might not be logged in yet
});

export { extpay };

export async function openPaymentPage() {
  await extpay.openPaymentPage();
}
