/**
 * ExtensionPay wrapper for Omni-Context Pro.
 *
 * ExtensionPay (https://extensionpay.com) handles one-time payments for
 * Chrome extensions without requiring your own backend.
 *
 * Flow:
 *   1. User clicks "Upgrade to Pro" → ExtPay.openPaymentPage()
 *   2. User pays on extensionpay.com → redirected back to extension
 *   3. Background polls payment status → sets omni_pro_status = true
 *
 * Replace EXTPAY_ID with your real ExtensionPay extension ID after
 * registering at https://extensionpay.com.
 */

const EXTPAY_ID = 'omni-context'; // placeholder — replace after registration

/**
 * Open the ExtensionPay payment page in a new tab.
 */
export async function openPaymentPage() {
  const url = `https://extensionpay.com/pay/${EXTPAY_ID}`;
  await chrome.tabs.create({ url });
}

/**
 * Check payment status against the ExtensionPay API.
 * Returns true if the current user has paid.
 */
export async function checkPaymentStatus() {
  try {
    const res = await fetch(
      `https://extensionpay.com/api/v1/extension/${EXTPAY_ID}/paid`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.paid === true;
  } catch (_) {
    return false;
  }
}

/**
 * Verify payment and persist pro status to chrome.storage.sync.
 * Called after user returns from ExtensionPay checkout.
 */
export async function activateIfPaid() {
  const paid = await checkPaymentStatus();
  if (paid) {
    await chrome.storage.sync.set({ omni_pro_status: true });
  }
  return paid;
}

export { EXTPAY_ID };
