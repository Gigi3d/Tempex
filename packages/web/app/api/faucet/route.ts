import { createPublicClient, createWalletClient, http, isAddress, parseAbi, parseUnits, formatUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoTestnet } from 'viem/tempo/chains';

import { RPC_URL } from '@tempex/sdk/browser';

export const dynamic = 'force-dynamic';

/// A small house faucet for when Tempo's testnet faucet is down. It sends a fixed
/// amount of testnet αUSD from a wallet funded only for this, at most once per
/// address every few minutes, so a demo never stalls on someone else's outage.

const TOKEN = (process.env.TEMPEX_TOKEN ?? '0x20c0000000000000000000000000000000000001') as Address;
const DRIP = parseUnits(process.env.FAUCET_DRIP ?? '100', 6);
const ADDRESS_GAP_MS = 5 * 60_000;
const IP_WINDOW_MS = 60 * 60_000;
const IP_LIMIT = 20;
const ERC20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

const lastByAddress = new Map<string, number>();
const hitsByIp = new Map<string, number[]>();

function wallet() {
  const key = process.env.FAUCET_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const account = privateKeyToAccount(key as `0x${string}`);
  const transport = http(process.env.TEMPO_RPC_URL ?? RPC_URL);
  return {
    account,
    pub: createPublicClient({ chain: tempoTestnet, transport }),
    client: createWalletClient({ chain: tempoTestnet, transport, account }),
  };
}

export async function GET() {
  const w = wallet();
  if (!w) return Response.json({ ok: false, error: 'faucet_unconfigured' }, { status: 503 });
  const balance = await w.pub.readContract({ address: TOKEN, abi: ERC20, functionName: 'balanceOf', args: [w.account.address] });
  return Response.json({ ok: true, address: w.account.address, balance: formatUnits(balance, 6), drip: formatUnits(DRIP, 6) });
}

export async function POST(request: Request) {
  const w = wallet();
  if (!w) return Response.json({ error: 'faucet_unconfigured', message: 'The testnet faucet is unavailable right now.' }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { address?: string } | null;
  const to = body?.address;
  if (!to || !isAddress(to)) return Response.json({ error: 'bad_address', message: 'That is not an address.' }, { status: 400 });

  const now = Date.now();
  const ip = request.headers.get('fly-client-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const hits = (hitsByIp.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) return Response.json({ error: 'rate_limited', message: 'Too many faucet requests; try again later.' }, { status: 429 });
  const last = lastByAddress.get(to.toLowerCase()) ?? 0;
  if (now - last < ADDRESS_GAP_MS) return Response.json({ error: 'rate_limited', message: 'This address was funded a moment ago; wait a few minutes.' }, { status: 429 });

  lastByAddress.set(to.toLowerCase(), now);
  hitsByIp.set(ip, [...hits, now]);
  try {
    const hash = await w.client.writeContract({ address: TOKEN, abi: ERC20, functionName: 'transfer', args: [to, DRIP] });
    return Response.json({ ok: true, hash, amount: formatUnits(DRIP, 6) });
  } catch (error) {
    lastByAddress.delete(to.toLowerCase());
    console.error('faucet transfer failed', error);
    return Response.json({ error: 'transfer_failed', message: 'The faucet could not send funds; try again shortly.' }, { status: 502 });
  }
}
