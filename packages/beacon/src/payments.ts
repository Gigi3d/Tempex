import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';

import { explorerAddress, explorerTx, hashText, memoTransfers, tip20Abi } from '@tempex/sdk';

import type { ChainReader } from './chain.js';
import { money, type Money } from './reputation.js';

export const PAYMENT_SCHEME = 'tempo-tx';
export const PAYMENT_HEADER = 'x-payment';
export const QUOTE_HEADER = 'x-payment-quote';
export const PAYMENT_TTL_SECONDS = 300;

/// A quote id is 16 random bytes. Validated before it is hashed or echoed back,
/// so a caller cannot make the beacon grind on arbitrary-length input.
const QUOTE_ID = /^0x[0-9a-fA-F]{32}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/// The memo a payer must attach, derived from the resource and the quote.
///
/// Derived rather than random so the gate needs no memory of quotes it issued:
/// after a restart it can still settle a payment made minutes earlier, because
/// the memo is recomputable. Hashed rather than raw so it can never collide with
/// a job memo, which is a bare job id — the escrow's own reconciliation key stays
/// unambiguous.
export function paymentMemo(resource: string, quoteId: string): Hex {
  return hashText(`tempex-beacon:${resource}:${quoteId.toLowerCase()}`);
}

export function newQuoteId(): string {
  return toHex(randomBytes(16));
}

export type PaymentQuote = {
  id: string;
  scheme: typeof PAYMENT_SCHEME;
  network: string;
  chainId: number;
  resource: string;
  amount: Money;
  token: Address;
  payTo: Address;
  memo: Hex;
  issuedAt: string;
  expiresAt: string;
  headers: {
    payment: { name: string; value: string };
    quote: { name: string; value: string };
  };
  /// One encoded call. The payer signs and submits it with its own key.
  pay: {
    method: string;
    to: Address;
    data: Hex;
    decoded: { function: string; args: Record<string, string> };
    rpcUrl: string;
    fee: { token: Address; sponsored: boolean; note: string };
  };
  /// What the beacon will check, so a payer can audit the gate instead of trusting it.
  verify: string[];
  /// Where the money goes, on the public explorer — readable before the payer sends anything.
  explorer: string;
};

/// The body of a `402 Payment Required`. Describes the scheme before any quote
/// exists, which is what lets an agent that has never seen this beacon pay it.
export type PaymentRequirement = {
  error: 'payment_required';
  scheme: typeof PAYMENT_SCHEME;
  network: string;
  chainId: number;
  resource: string;
  amount: Money;
  token: Address;
  payTo: Address | null;
  accepts: string;
  headers: { payment: string; quote: string };
  quote: { endpoint: string; method: 'GET' };
  note: string;
};

export type SpentPayment = {
  key: string;
  tx: Hex;
  memo: Hex;
  quoteId: string;
  resource: string;
  payer: Address;
  amount: Money;
  block: number;
  settledAt: string;
};

export type Settlement = {
  free: boolean;
  resource: string;
  quoteId: string | null;
  tx: Hex | null;
  memo: Hex | null;
  payer: Address | null;
  amount: Money | null;
  explorer: string | null;
};

export type SettleResult =
  | { ok: true; settled: Settlement }
  | { ok: false; status: 400 | 402 | 409; reason: string };

export type PaymentGateParams = {
  reader: ChainReader;
  chainId: number;
  network: string;
  rpcUrl: string;
  explorerUrl: string;
  token: Address;
  decimals: number;
  /// Null means discovery is free: there is nowhere to be paid.
  treasury: Address | null;
  price: bigint;
  file: string;
};

type SpentFile = { version: 1; spent: SpentPayment[] };

/// Keeps the replay set bounded. A beacon that ran for a year should not load a
/// year of receipts into memory to answer one query.
const SPENT_LIMIT = 5_000;

const FREE: Money = { units: '0', value: '0' };

/// HTTP 402, settled on-chain in the same stablecoin the escrow uses.
///
/// The gate holds no funds and no keys: `payTo` is the beacon treasury, the payer
/// signs its own transaction, and settlement is a receipt read. The only state is
/// the replay set, and losing it cannot create money — it can only make the beacon
/// re-check a transaction the chain already settled.
export class PaymentGate {
  private readonly spent = new Map<string, SpentPayment>();

  constructor(private readonly params: PaymentGateParams) {
    this.load();
  }

  get enabled(): boolean {
    return this.params.treasury !== null && this.params.price > 0n;
  }

  get price(): Money {
    return money(this.params.price, this.params.decimals);
  }

  /// What an unpayed caller is told. Always available, even when the gate is off,
  /// so an agent can learn the scheme before deciding whether it wants the data.
  requirement(resource: string): PaymentRequirement {
    const { params } = this;
    return {
      error: 'payment_required',
      scheme: PAYMENT_SCHEME,
      network: params.network,
      chainId: params.chainId,
      resource,
      amount: this.price,
      token: params.token,
      payTo: params.treasury,
      accepts: `${PAYMENT_SCHEME}:<transactionHash>`,
      headers: { payment: PAYMENT_HEADER, quote: QUOTE_HEADER },
      quote: { endpoint: `${resource}?quote=1`, method: 'GET' },
      note: this.enabled
        ? 'Fetch a quote, send one transferWithMemo carrying the returned memo, then retry with both headers. The receipt is the proof; nothing is held in custody.'
        : 'No treasury is configured, so this beacon serves discovery for free.',
    };
  }

  issueQuote(resource: string): PaymentQuote {
    const { params } = this;
    const treasury = params.treasury;
    if (treasury === null) {
      throw new Error('the beacon has no treasury, so it cannot quote a price');
    }

    const id = newQuoteId();
    const memo = paymentMemo(resource, id);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + PAYMENT_TTL_SECONDS * 1000);
    const data = encodeFunctionData({
      abi: tip20Abi,
      functionName: 'transferWithMemo',
      args: [treasury, params.price, memo],
    });

    return {
      id,
      scheme: PAYMENT_SCHEME,
      network: params.network,
      chainId: params.chainId,
      resource,
      amount: this.price,
      token: params.token,
      payTo: treasury,
      memo,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      headers: {
        payment: { name: 'X-Payment', value: `${PAYMENT_SCHEME}:<transactionHash>` },
        quote: { name: 'X-Payment-Quote', value: id },
      },
      pay: {
        method: 'eth_sendTransaction',
        to: params.token,
        data,
        decoded: {
          function: 'transferWithMemo',
          args: { to: treasury, amount: params.price.toString(), memo },
        },
        rpcUrl: params.rpcUrl,
        fee: {
          token: params.token,
          sponsored: true,
          note: 'Set `feePayer: true` and Tempo’s hosted fee payer covers the fee, so paying this costs exactly the price and nothing else.',
        },
      },
      verify: [
        `The memo is keccak256("tempex-beacon:${resource}:${id.toLowerCase()}") — recompute it and check it matches.`,
        `Payment is a TransferWithMemo to ${treasury} of at least ${params.price.toString()} units; the beacon reads that log from the receipt.`,
        `A transaction hash can satisfy one quote only; replays are answered 409 with the original settlement.`,
        `Nothing is escrowed or held: the transfer is final the moment the block lands.`,
      ],
      explorer: explorerAddress(treasury),
    };
  }

  /// Checks a payment header against the chain and, if it holds, records it.
  async settle(resource: string, header: string | null, quoteId: string | null): Promise<SettleResult> {
    if (!this.enabled || this.params.treasury === null) {
      return {
        ok: true,
        settled: {
          free: true,
          resource,
          quoteId: null,
          tx: null,
          memo: null,
          payer: null,
          amount: FREE,
          explorer: null,
        },
      };
    }

    const parsed = parsePaymentHeader(header);
    if (!parsed) {
      /// An unpaid request is not a bad request. 402 is the status an agent framework
      /// watches for in order to start a payment flow, so the price and the way to pay
      /// it have to be behind 402 and not behind a 400 that reads as caller error.
      if (header === null) {
        return {
          ok: false,
          status: 402,
          reason:
            `${resource} costs ${this.price.value} units of token ${this.params.token}. ` +
            `GET ${resource}?quote=1 for a quote, send its amount to payTo with transferWithMemo, ` +
            `then retry with ${PAYMENT_HEADER}: ${PAYMENT_SCHEME}:<transactionHash> and ${QUOTE_HEADER}: <quote id>.`,
        };
      }
      return {
        ok: false,
        status: 400,
        reason:
          `malformed ${PAYMENT_HEADER}, got "${header.slice(0, 80)}"; ` +
          `expected "${PAYMENT_SCHEME}:<transactionHash>"`,
      };
    }
    if (!quoteId || !QUOTE_ID.test(quoteId)) {
      return {
        ok: false,
        status: 400,
        reason: `missing or malformed ${QUOTE_HEADER}; expected the 32-hex-character quote id from the 402 body`,
      };
    }

    const treasury = this.params.treasury;
    const memo = paymentMemo(resource, quoteId);
    const key = `${parsed.tx.toLowerCase()}:${memo.toLowerCase()}`;
    const replay = this.spent.get(key);
    if (replay) {
      return {
        ok: false,
        status: 409,
        reason: `this payment was already settled at ${replay.settledAt} for ${replay.resource}`,
      };
    }

    const receipt = await this.params.reader
      .getTransactionReceipt({ hash: parsed.tx })
      .catch(() => null);
    if (!receipt) {
      return { ok: false, status: 402, reason: `no receipt for ${parsed.tx}; is it mined on ${this.params.network}?` };
    }
    if (receipt.status !== 'success') {
      return { ok: false, status: 402, reason: `${parsed.tx} reverted, so no transfer happened` };
    }

    const token = this.params.token.toLowerCase();
    const transfers = memoTransfers(receipt.logs.filter((log) => log.address.toLowerCase() === token));
    const match = transfers.find(
      (transfer) =>
        transfer.to.toLowerCase() === treasury.toLowerCase() &&
        transfer.memo.toLowerCase() === memo.toLowerCase() &&
        transfer.amount >= this.params.price,
    );
    if (!match) {
      return {
        ok: false,
        status: 402,
        reason:
          `${parsed.tx} contains no TransferWithMemo to ${treasury} for at least ` +
          `${this.params.price.toString()} units with memo ${memo}. The memo binds the payment to this quote and this resource.`,
      };
    }

    const record: SpentPayment = {
      key,
      tx: parsed.tx,
      memo,
      quoteId: quoteId.toLowerCase(),
      resource,
      payer: match.from,
      amount: money(match.amount, this.params.decimals),
      block: Number(receipt.blockNumber),
      settledAt: new Date().toISOString(),
    };
    this.spent.set(key, record);
    this.persist();

    return {
      ok: true,
      settled: {
        free: false,
        resource,
        quoteId: record.quoteId,
        tx: record.tx,
        memo: record.memo,
        payer: record.payer,
        amount: record.amount,
        explorer: explorerTx(record.tx),
      },
    };
  }

  /// Recent settlements, so an operator can see the gate working without reading logs.
  history(limit = 20): SpentPayment[] {
    return [...this.spent.values()].slice(-limit).reverse();
  }

  get size(): number {
    return this.spent.size;
  }

  private load(): void {
    if (!existsSync(this.params.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.params.file, 'utf8')) as SpentFile;
      for (const record of parsed.spent ?? []) {
        if (record?.key) this.spent.set(record.key, record);
      }
    } catch {
      // A corrupt replay set must not brick the beacon. The worst case is that a
      // previously spent hash is re-checked against the chain, which still settles
      // it exactly once for the quote it names.
      this.spent.clear();
    }
  }

  private persist(): void {
    const dir = dirname(this.params.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const spent = [...this.spent.values()].slice(-SPENT_LIMIT);
    const payload: SpentFile = { version: 1, spent };
    writeFileSync(this.params.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }
}

export function parsePaymentHeader(value: string | null): { scheme: string; tx: Hex } | null {
  if (!value) return null;
  const trimmed = value.trim();
  const [scheme, rest] = trimmed.includes(':')
    ? [trimmed.slice(0, trimmed.indexOf(':')), trimmed.slice(trimmed.indexOf(':') + 1)]
    : [PAYMENT_SCHEME, trimmed];
  if (scheme.toLowerCase() !== PAYMENT_SCHEME) return null;
  if (!TX_HASH.test(rest)) return null;
  return { scheme: PAYMENT_SCHEME, tx: rest.toLowerCase() as Hex };
}
