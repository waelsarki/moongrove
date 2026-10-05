import { run } from '../../db/index.js';
import { id, nowIso, sleep } from '../../lib/util.js';
import { unprocessable } from '../../lib/errors.js';
import { importStatementLine } from '../recon.js';

/**
 * Base bank adapter (plan Sec.6: standardised adapter interface).
 *
 * In production each concrete adapter wraps one bank's real API/host-to-host
 * channel. Capabilities DIFFER per bank (plan Sec.4) - which is exactly why
 * every bank is modelled as a plugin behind this one contract.
 *
 * The base class supplies the shared lifecycle (idempotency, retries, latency,
 * logging) so concrete adapters only implement `doTransfer` / `doStatement`.
 */
export class BankAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.code       bank code, e.g. 'PROVIDUS'
   * @param {string} opts.name       display name
   * @param {number} opts.wave       onboarding wave (plan Sec.17)
   * @param {number[]} opts.supportedCurrencies settlement currencies
   * @param {number} opts.costBps    indicative per-transfer cost
   * @param {number} opts.baseLatencyMs simulated round-trip latency
   * @param {number} opts.failureRate 0..1 simulated transient failure rate
   */
  constructor({ code, name, wave, supportedCurrencies, costBps, baseLatencyMs, failureRate }) {
    this.code = code;
    this.name = name;
    this.wave = wave;
    this.supportedCurrencies = supportedCurrencies ?? ['NGN'];
    this.costBps = costBps ?? 40;
    this.baseLatencyMs = baseLatencyMs ?? 120;
    this.failureRate = failureRate ?? 0.02;
  }

  /** Whether this bank can settle a given currency (capability variance). */
  supports(currency) {
    return this.supportedCurrencies.includes(currency);
  }

  estimateFee(amount) {
    // $15 flat + 0.40% illustrative, per bank shape.
    return Math.max(15, amount * (this.costBps / 10_000));
  }

  /**
   * Execute an outbound transfer with retry on transient errors.
   * @param {object} req { paymentId, amount, currency, accountNumber, idempotencyKey }
   * @returns {Promise<{status, providerRef, settledAt, latencyMs, attempts, fee}>}
   */
  async transfer(req) {
    const started = Date.now();
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.doTransfer(req, attempt);
        return { ...result, latencyMs: Date.now() - started, attempts: attempt };
      } catch (err) {
        lastErr = err;
        // Retry only transient errors; decline/validation are final.
        if (!err.transient || attempt === 3) break;
        await sleep(this.baseLatencyMs * attempt);
      }
    }
    throw lastErr;
  }

  /** Concrete adapters override. */
  async doTransfer(req, attempt) {
    await sleep(this.baseLatencyMs);
    // Simulated transient outage to exercise failover.
    if (Math.random() < this.failureRate) {
      const err = unprocessable(`${this.name}: temporary outage (attempt ${attempt})`);
      err.transient = true;
      err.errorCode = 'BANK_UNAVAILABLE';
      throw err;
    }
    const providerRef = `${this.code}-${Date.now().toString(36).toUpperCase()}`;

    // A real bank posts the credit to the client's statement; emulate that so
    // downstream 4-way reconciliation has a statement leg to match against.
    importStatementLine({
      bankCode: this.code,
      valueDate: new Date().toISOString().slice(0, 10),
      currency: req.currency,
      amount: req.amount,
      reference: req.paymentId,
      providerRef,
    });

    return {
      status: 'SUCCEEDED',
      providerRef,
      settledAt: nowIso(),
      fee: this.estimateFee(req.amount),
    };
  }

  /** Fetch statement lines for reconciliation (plan Sec.11). */
  async statement(_accountNumber, _valueDate) {
    await sleep(this.baseLatencyMs / 2);
    return [];
  }
}
