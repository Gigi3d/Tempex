// How does Tempo's keychain meter an access key's budget on approve? Measured,
// so the console can tell owners exactly what their budget means.
import { encodeFunctionData } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Account, Actions, createClient, http, withFeePayer } from 'viem/tempo';
import { tempoTestnet } from 'viem/tempo/chains';

import { RPC_URL, SPONSOR_URL, addressesFromEnv, agentScopes, loadEnv, tip20Abi } from '@tempex/sdk';

loadEnv(new URL('../../..', import.meta.url).pathname);
const { escrow, token } = addressesFromEnv();
const transport = withFeePayer(http(RPC_URL), http(SPONSOR_URL));
const owner = Account.fromP256(generatePrivateKey());
const ownerClient = createClient({ account: owner, chain: tempoTestnet, feeToken: token, transport });
const key = Account.fromP256(generatePrivateKey(), { access: owner });
const keyClient = createClient({ account: key, chain: tempoTestnet, feeToken: token, transport });
const reader = createClient({ chain: tempoTestnet, transport: http(RPC_URL) });
await ownerClient.faucet.fund({ account: owner.address });
const wait = (hash: `0x${string}`) => ownerClient.waitForTransactionReceipt({ hash, checkReplacement: false });
await wait(await Actions.accessKey.authorize(ownerClient, { accessKey: key, expiry: Math.floor(Date.now() / 1000) + 3600, limits: [{ token, limit: 100_000_000n }], scopes: agentScopes('buyer', escrow, token), feePayer: true } as never));
const state = async (label: string) => {
  const remaining = (await Actions.accessKey.getRemainingLimit(reader, { account: owner.address, accessKey: key.accessKeyAddress, token } as never)).remaining;
  const allowance = await reader.readContract({ address: token, abi: tip20Abi, functionName: 'allowance', args: [owner.address, escrow] });
  console.log(`${label.padEnd(34)} budget left ${Number(remaining) / 1e6}, allowance ${Number(allowance) / 1e6}`);
};
const approve = async (amount: bigint) =>
  keyClient.waitForTransactionReceipt({
    hash: await keyClient.sendTransaction({ calls: [{ to: token, data: encodeFunctionData({ abi: tip20Abi, functionName: 'approve', args: [escrow, amount] }) }], feePayer: true } as never),
    checkReplacement: false,
  });
await state('authorized, limit 100');
await approve(30_000_000n); await state('approve 30 (allowance 0 -> 30)');
await approve(30_000_000n); await state('approve 30 again (30 -> 30)');
await approve(40_000_000n); await state('approve 40 (30 -> 40)');
await approve(10_000_000n); await state('approve 10 (40 -> 10)');
