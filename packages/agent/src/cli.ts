#!/usr/bin/env tsx
import { getAddress, type Address } from 'viem';

import { readFileSync } from 'node:fs';

import { AGENT_PERIODS, AGENT_ROLES, EXPLORER_URL, formatToken, tokenAmount, type AgentPeriod, type AgentRole, type JobTerms } from '@tempex/sdk';

import { agentStanding, agentTempex, fileTerms } from './client.js';
import { createAgent, defaultAgentFile, loadAgent, saveOwner } from './keystore.js';
import { requestPairing, verifyApproval, waitForApproval } from './pairing.js';

const out = (line = ''): void => console.log(line);
const row = (label: string, value: string): void => out(`  ${label.padEnd(14)}${value}`);

function flags(argv: string[]): { command: string; flags: Record<string, string | true> } {
  const [command = 'help', ...rest] = argv;
  const parsed: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[token.slice(2)] = next;
      i += 1;
    } else parsed[token.slice(2)] = true;
  }
  return { command, flags: parsed };
}

const beaconUrl = (f: Record<string, string | true>): string =>
  String(f['beacon'] ?? process.env['TEMPEX_BEACON_URL'] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

/// The escrow and token come from the beacon's manifest, so an agent needs one URL
/// to start. They are printed for the operator to check, and can be pinned.
async function protocol(beacon: string): Promise<{ escrow: Address; token: Address; network: string }> {
  const response = await fetch(`${beacon}/.well-known/tempex.json`);
  if (!response.ok) throw new Error(`cannot read ${beacon}/.well-known/tempex.json (${response.status})`);
  const manifest = (await response.json()) as { protocol: { escrow: string; paymentToken: { address: string } }; identity?: { network?: string } };
  const escrow = getAddress(process.env['TEMPEX_ESCROW'] || manifest.protocol.escrow);
  if (process.env['TEMPEX_ESCROW'] && escrow.toLowerCase() !== manifest.protocol.escrow.toLowerCase()) {
    throw new Error(`the beacon serves escrow ${manifest.protocol.escrow}, but TEMPEX_ESCROW pins ${escrow}; refusing to pair`);
  }
  return { escrow, token: getAddress(manifest.protocol.paymentToken.address), network: manifest.identity?.network ?? 'tempo' };
}

async function main(argv: string[]): Promise<number> {
  const { command, flags: f } = flags(argv);
  switch (command) {
    case 'init': {
      const name = String(f['name'] ?? 'my-agent');
      const role = String(f['role'] ?? 'buyer') as AgentRole;
      if (!AGENT_ROLES.includes(role)) throw new Error('--role must be buyer, seller or both');
      const passphrase = process.env['TEMPEX_AGENT_PASSPHRASE'];
      const agent = createAgent({ name, role, force: f['force'] === true, ...(passphrase ? { passphrase } : {}) });
      out('Agent key created. The private key never leaves this machine.');
      row('name', `${agent.name} (${agent.role})`);
      row('key id', agent.keyId);
      row('file', `${agent.file} (owner-only${passphrase ? ', encrypted' : '; set TEMPEX_AGENT_PASSPHRASE to encrypt'})`);
      out();
      out('Next: `tempex-agent pair --limit 100 --period week --days 30` and send the link to the owner.');
      return 0;
    }
    case 'pair': {
      const beacon = beaconUrl(f);
      const agent = loadAgent();
      const { escrow, network } = await protocol(beacon);
      const period = String(f['period'] ?? 'week') as AgentPeriod;
      if (!(period in AGENT_PERIODS)) throw new Error('--period must be none, day, week or month');
      const ticket = await requestPairing({
        agent,
        beacon,
        escrow,
        limit: String(f['limit'] ?? (agent.role === 'seller' ? '0' : '100')),
        period,
        days: Number(f['days'] ?? 30),
      });
      out(`Pairing ${agent.name} with its owner on ${network}, escrow ${escrow}`);
      out();
      out(`  ┌──────────────────────────────┐`);
      out(`  │  code   ${ticket.code.padEnd(21)}│`);
      out(`  └──────────────────────────────┘`);
      out(`  Owner approves at: ${ticket.approveUrl}`);
      out(`  Asking for: ${ticket.request.role}, ${ticket.request.limit === '0' ? 'no spending' : `${formatToken(BigInt(ticket.request.limit))} αUSD`}${ticket.request.period ? ` per ${period}` : ''}, for ${ticket.request.days} days`);
      out(`  Expires: ${ticket.expiresAt}`);
      out();
      let last = '';
      const state = await waitForApproval({
        beacon,
        code: ticket.code,
        onTick: (s) => {
          if (s.status !== last) out(`  … ${s.status}`);
          last = s.status;
        },
      });
      if (state.status !== 'approved' || !state.approval) throw new Error('the pairing expired before the owner approved it');
      const verified = await verifyApproval({ agent, request: ticket.request, tx: state.approval.tx });
      saveOwner(agent, verified.owner, { code: ticket.code, tx: state.approval.tx, approvedAt: new Date().toISOString(), beacon });
      out('Approved, and verified on chain (not just on the beacon’s word).');
      row('owner', verified.owner);
      row('expires', verified.expiry ? new Date(verified.expiry * 1000).toISOString() : 'never');
      row('authorized', `${EXPLORER_URL}/tx/${state.approval.tx}`);
      return 0;
    }
    case 'status':
    case 'whoami': {
      const agent = loadAgent();
      out(`${agent.name} (${agent.role})`);
      row('key id', agent.keyId);
      row('file', agent.file ?? 'injected from the environment');
      if (!agent.owner) {
        row('owner', 'none yet: run `tempex-agent pair`');
        return 0;
      }
      row('owner', agent.owner);
      if (command === 'whoami') return 0;
      const { token } = await protocol(beaconUrl(f));
      const standing = await agentStanding(agent, token);
      if (!standing) return 0;
      row('key', standing.revoked ? 'REVOKED by its owner' : standing.expired ? 'EXPIRED' : 'live');
      row('expires', standing.expiry ? new Date(standing.expiry * 1000).toISOString() : 'never');
      row('budget left', standing.remaining === null ? (standing.spendPolicy === 'unlimited' ? 'unlimited' : 'none') : `${formatToken(standing.remaining)} αUSD${standing.periodEnd ? `, resets ${new Date(standing.periodEnd * 1000).toISOString()}` : ''}`);
      return 0;
    }
    case 'open': {
      // Opens and funds a job as this agent. It settles as the owner, inside the
      // key's budget; the keychain refuses it otherwise.
      const agent = loadAgent();
      const seller = typeof f['seller'] === 'string' ? getAddress(f['seller']) : null;
      const spec = typeof f['terms'] === 'string' ? f['terms'] : null;
      const file = typeof f['terms-file'] === 'string' ? f['terms-file'] : null;
      if (!seller || (!spec && !file)) throw new Error('open needs --seller <address> --amount <αUSD> and --terms <text> or --terms-file <terms.json>');
      if (!agent.owner) throw new Error('this agent has no owner yet: run `tempex-agent pair` first');
      const beacon = beaconUrl(f);
      const { escrow, token } = await protocol(beacon);
      const price = String(f['amount'] ?? '1');
      const amount = tokenAmount(price);
      // The terms are a document both sides (and the arbiter) can read, filed by
      // hash before the job commits to that hash. A file carries full terms; a
      // line of text becomes the spec, with --title and --criteria "a | b".
      const base = file ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<JobTerms>) : {};
      const terms: JobTerms = {
        title: String(f['title'] ?? base.title ?? spec!.slice(0, 80)),
        deliverableSpec: base.deliverableSpec ?? spec!,
        acceptanceCriteria:
          typeof f['criteria'] === 'string'
            ? f['criteria'].split('|').map((part) => part.trim()).filter(Boolean)
            : (base.acceptanceCriteria ?? ['Delivers what the spec describes']),
        amount: price,
        currency: 'αUSD',
        buyer: getAddress(agent.owner),
        seller,
      };
      // Check standing first: a revoked or expired key fails on chain with an
      // unhelpful error, and the operator deserves the real reason.
      const standing = await agentStanding(agent, token);
      if (standing?.revoked) throw new Error('this key was revoked by its owner; ask them to pair a new one');
      if (standing?.expired) throw new Error('this key has expired; run `tempex-agent pair` for a new one');
      const tempex = agentTempex(agent, { escrow, token });
      const opened = await tempex.createAndFundJob(
        {
          approve: true,
          seller,
          amount,
          termsHash: await fileTerms(beacon, terms),
          deliveryDeadline: Math.floor(Date.now() / 1000) + Number(f['hours'] ?? 24) * 3600,
          reviewWindow: 3600,
        },
        { sponsored: true },
      );
      const job = await tempex.job(opened.jobId);
      out(`Opened job ${opened.jobId}: ${formatToken(job.amount)} αUSD escrowed, buyer ${job.buyer} (the owner).`);
      row('terms', `${terms.title} · filed under ${job.termsHash}`);
      row('tx', `${EXPLORER_URL}/tx/${opened.hash}`);
      return 0;
    }
    case 'help':
    default:
      out('tempex-agent — a scoped Tempo wallet for an agent, approved by its owner');
      out();
      out('  init  [--name <n>] [--role buyer|seller|both] [--force]   create this agent\'s key (TEMPEX_AGENT_PASSPHRASE encrypts it)');
      out('  pair  [--limit <αUSD>] [--period none|day|week|month] [--days <n>] [--beacon <url>]   ask the owner to authorize it');
      out('  status                                                  key, owner, expiry and budget left, read from chain');
      out('  whoami                                                  key id and owner');
  out('  open  --seller <address> --amount <αUSD> --terms <text> [--title <t>] [--criteria "a | b"] [--terms-file <json>] [--hours <n>]');
      out('                                                          file the terms, then open and fund a job as the owner, within budget');
      out();
      out(`Key file: ${defaultAgentFile()} · beacon: TEMPEX_BEACON_URL or --beacon`);
      return command === 'help' ? 0 : 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`tempex-agent: ${explain(error)}`);
    process.exit(1);
  });

/// The keychain's refusals, in words an operator can act on.
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/SpendingLimitExceeded/.test(message)) return 'over budget: the owner\'s limit for this key does not cover this; run `tempex-agent status`, or ask the owner to raise it';
  if (/CallNotAllowed/.test(message)) return 'this key is not allowed to make that call (its role does not cover it)';
  if (/KeyExpired/.test(message)) return 'this key has expired; run `tempex-agent pair` for a new one';
  if (/KeyNotFound|KeyRevoked/.test(message)) return 'this key is not authorized on its owner\'s account (revoked or never approved)';
  return message.split('\n')[0] ?? message;
}
