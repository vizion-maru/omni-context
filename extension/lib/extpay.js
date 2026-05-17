import ExtPay from './ExtPay.esm.js';
const extpay = ExtPay('omnicontext');
extpay.startBackground();
export { extpay };
export async function openPaymentPage() {
  await extpay.openPaymentPage();
}
