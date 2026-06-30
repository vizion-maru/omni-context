import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _syncStore } from './chrome-mock.js';

const extpayMock = vi.hoisted(() => ({
  listeners: {},
  startBackground: vi.fn(),
  onPaid: { addListener: vi.fn((fn) => { extpayMock.listeners.paid = fn; }) },
  onTrialStarted: { addListener: vi.fn((fn) => { extpayMock.listeners.trial = fn; }) },
  getUser: vi.fn(() => Promise.resolve({ paid: false })),
  openPaymentPage: vi.fn(() => Promise.resolve()),
  openTrialPage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../extension/lib/ExtPay.esm.js', () => ({
  default: vi.fn(() => extpayMock),
}));

const {
  DEFAULT_PLANS,
  TRIAL_CONFIG,
  evaluateProStatus,
  openPaymentPage,
  openTrialPage,
} = await import('../extension/lib/extpay.js');

describe('ExtPay Pro subscription/trial plumbing', () => {
  beforeEach(() => {
    for (const key of Object.keys(_syncStore)) delete _syncStore[key];
    extpayMock.openPaymentPage.mockClear();
    extpayMock.openTrialPage.mockClear();
    extpayMock.getUser.mockClear();
  });

  it('treats paid ExtPay users as Pro even when only user.paid is present', () => {
    expect(evaluateProStatus({ paid: true }).isPro).toBe(true);
    expect(evaluateProStatus({ paid: true }).isPaid).toBe(true);
  });

  it('treats active 7-day trials as Pro and expired trials as free', () => {
    const active = evaluateProStatus({
      paid: false,
      trialStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(active.isPro).toBe(true);
    expect(active.isTrialActive).toBe(true);
    expect(active.trialDaysLeft).toBeGreaterThan(0);

    const expired = evaluateProStatus({
      paid: false,
      trialStartedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(expired.isPro).toBe(false);
    expect(expired.isTrialActive).toBe(false);
  });

  it('routes selected subscription plans and trial label to ExtPay', async () => {
    await openPaymentPage(DEFAULT_PLANS.monthly);
    expect(extpayMock.openPaymentPage).toHaveBeenCalledWith('pro_monthly_399');

    await openPaymentPage(DEFAULT_PLANS.annual);
    expect(extpayMock.openPaymentPage).toHaveBeenCalledWith('pro_yearly_29');

    await openTrialPage();
    expect(extpayMock.openTrialPage).toHaveBeenCalledWith(TRIAL_CONFIG.periodLabel);
    expect(TRIAL_CONFIG.periodLabel).toBe('7-day Pro');
  });

  it('unlocks Pro immediately from onPaid and onTrialStarted callbacks', async () => {
    const paidListener = extpayMock.listeners.paid;
    await paidListener({ paid: true, email: 'paid@example.test' });
    expect(_syncStore.omni_pro_status).toBe(true);
    expect(_syncStore.omni_pro_source).toBe('paid');

    const trialListener = extpayMock.listeners.trial;
    await trialListener({
      paid: false,
      trialStartedAt: new Date().toISOString(),
      email: 'trial@example.test',
    });
    expect(_syncStore.omni_pro_status).toBe(true);
    expect(_syncStore.omni_pro_source).toBe('trial');
    expect(new Date(_syncStore.omni_pro_trial_expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});
