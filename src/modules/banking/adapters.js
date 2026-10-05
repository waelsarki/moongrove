import { BankAdapter } from './adapter.js';

/**
 * Concrete adapters - one per target bank (plan Sec.4/17).
 * Differing supportedCurrencies / cost / latency / reliability model the real
 * capability variance the plan warns about (Sec.4). A real deployment replaces
 * each doTransfer body with that bank's actual API call.
 */
const DEFINITIONS = [
  { code: 'PROVIDUS', name: 'Providus Bank', wave: 1, supportedCurrencies: ['NGN', 'USD', 'GBP'], costBps: 45, baseLatencyMs: 130, failureRate: 0.02 },
  { code: 'ACCESS', name: 'Access Bank', wave: 1, supportedCurrencies: ['NGN', 'USD', 'EUR'], costBps: 42, baseLatencyMs: 110, failureRate: 0.02 },
  { code: 'UBA', name: 'United Bank for Africa', wave: 1, supportedCurrencies: ['NGN', 'USD', 'EUR', 'GBP', 'GHS'], costBps: 48, baseLatencyMs: 150, failureRate: 0.03 },
  { code: 'GTBANK', name: 'GTBank', wave: 2, supportedCurrencies: ['NGN', 'USD', 'EUR'], costBps: 44, baseLatencyMs: 120, failureRate: 0.02 },
  { code: 'ZENITH', name: 'Zenith Bank', wave: 2, supportedCurrencies: ['NGN', 'USD', 'GBP'], costBps: 43, baseLatencyMs: 115, failureRate: 0.02 },
  { code: 'FIRSTBANK', name: 'First Bank of Nigeria', wave: 2, supportedCurrencies: ['NGN'], costBps: 50, baseLatencyMs: 160, failureRate: 0.03 },
  { code: 'ECOBANK', name: 'Ecobank', wave: 3, supportedCurrencies: ['NGN', 'USD', 'EUR', 'XOF', 'XAF'], costBps: 47, baseLatencyMs: 140, failureRate: 0.02 },
  { code: 'JAIZ', name: 'Jaiz Bank', wave: 3, supportedCurrencies: ['NGN'], costBps: 52, baseLatencyMs: 170, failureRate: 0.04 },
  { code: 'STERLING', name: 'Sterling Bank', wave: 3, supportedCurrencies: ['NGN', 'USD'], costBps: 46, baseLatencyMs: 125, failureRate: 0.02 },
];

const registry = new Map();

for (const def of DEFINITIONS) {
  registry.set(def.code, new BankAdapter(def));
}

export function getAdapter(bankCode) {
  const a = registry.get(bankCode);
  if (!a) throw new Error(`Unknown bank adapter: ${bankCode}`);
  return a;
}

export const allAdapters = () => [...registry.values()];

export const bankCodeList = () => [...registry.keys()];

export { DEFINITIONS as BANK_DEFINITIONS };
