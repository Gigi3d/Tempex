// Spike: do Tempo access keys work with the Tempex escrow? Every assumption the
// agent wallet design rests on, checked against Moderato before building on it.
import { encodeFunctionData, keccak256, toHex, type Address } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Account, Actions, Scopes, createClient, http, withFeePayer } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { RPC_URL, SPONSOR_URL, TempexClient, addressesFromEnv, hashText, loadEnv, tip20Abi } from '@tempex/sdk';

loadEnv(new URL('../../..', import.meta.url).pathname);
const { escrow, token } = addressesFromEnv();
const t0 = Date.now();
const log = (step: string, detail: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${step.padEnd(22)} ${detail}`);
const transport = withFeePayer(http(RPC_URL), http(SPONSOR_URL));

// The owner: a P-256 root account, standing in for a passkey (same key type).
const owner = Account.fromP256(generatePrivateKey());
const ownerClient = createClient({ account: owner, chain: tempoTestnet, feeToken: token, transport });
// The agent: its own P-256 key, acting for the owner's account.
const agentKey = Account.fromP256(generatePrivateKey(), { access: owner });
log('accounts', `owner ${owner.address} · agent key ${agentKey.accessKeyAddress} · agent signs as ${agentKey.address}`);

await ownerClient.faucet.fund({ account: owner.address });
const tempex = new TempexClient({ account: owner, addresses: { escrow, token }, sponsorUrl: SPONSOR_URL });
for (let i = 0; i < 30 && (await tempex.tokenBalance()) === 0n; i++) await new Promise((r) => setTimeout(r, 1000));
log('faucet', `owner holds ${await tempex.tokenBalance()}`);

const witness = keccak256(toHex('tempex-pairing-spike-' + Date.now()));
const authorizeHash = await Actions.accessKey.authorize(ownerClient, {
  accessKey: agentKey,
  expiry: Math.floor(Date.now() / 1000) + 3600,
  limits: [{ token, limit: 30_000_000n }],
  scopes: [Scopes.target(escrow).any(), Scopes.tip20(token).approve({ recipients: [escrow] })],
  witness,
  feePayer: true,
} as never);
const authorized = await ownerClient.waitForTransactionReceipt({ hash: authorizeHash, checkReplacement: false });
log('authorize', `${authorized.status} ${authorizeHash.slice(0, 18)} (30 αUSD limit, 1h expiry, escrow + approve-to-escrow only, witness bound)`);

const meta = await Actions.accessKey.getMetadata(ownerClient, { account: owner.address, accessKey: agentKey.accessKeyAddress } as never);
log('metadata', JSON.stringify(meta, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

const agent = new TempexClient({ account: agentKey as never, addresses: { escrow, token }, sponsorUrl: SPONSOR_URL });
const seller = Account.fromP256(generatePrivateKey()).address;
const opened = await agent.approveEscrow(25_000_000n, { sponsored: true }).then(() =>
  agent.createAndFundJob(
    { seller, amount: 25_000_000n, termsHash: hashText('spike terms'), deliveryDeadline: Math.floor(Date.now() / 1000) + 3600, reviewWindow: 3600 },
    { sponsored: true },
  ),
);
const job = await agent.job(opened.jobId);
log('agent opens job', `job ${opened.jobId}: buyer ${job.buyer} ${job.buyer.toLowerCase() === owner.address.toLowerCase() ? '== owner ✓' : '!= owner ✗'}, ${job.state}, ${job.amount}`);

const remaining = await Actions.accessKey.getRemainingLimit(ownerClient, { account: owner.address, accessKey: agentKey.accessKeyAddress, token } as never);
log('limit metered', `remaining ${remaining.remaining} of 30000000 after a 25 αUSD approve`);

const expectFail = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run();
    log(label, '✗ went through (should not have)');
  } catch (error) {
    log(label, `✓ refused: ${((error as Error).message.split('\n').find((l) => /Details|reverted|Error|exceed|scope|not allowed|Unauthorized/i.test(l)) ?? (error as Error).message.split('\n')[0] ?? '').slice(0, 140)}`);
  }
};
await expectFail('over the limit', () => agent.approveEscrow(10_000_000n, { sponsored: true }));
await expectFail('out of scope', () =>
  agent.viem.sendTransaction({ calls: [{ to: token, data: encodeFunctionData({ abi: tip20Abi, functionName: 'transfer', args: [seller as Address, 1n] }) }], feePayer: true } as never),
);

const revokeHash = await Actions.accessKey.revoke(ownerClient, { accessKey: agentKey.accessKeyAddress, feePayer: true } as never);
await ownerClient.waitForTransactionReceipt({ hash: revokeHash, checkReplacement: false });
log('revoke', revokeHash.slice(0, 18));
await expectFail('after revoke', () => agent.approveEscrow(1n, { sponsored: true }));
log('done', 'every assumption checked');
