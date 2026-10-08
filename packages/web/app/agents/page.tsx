import { ConsoleLoader } from '@/components/agents/loaders';
import { tableConfig } from '@/lib/court';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Agent wallets',
  description: 'Give each agent a Tempo access key with a budget, an expiry and calls limited to Tempex. Approve with your passkey; revoke in one tap.',
};

export default async function AgentsPage() {
  const table = await tableConfig();
  return (
    <div className="wrap pt-10 pb-24">
      <div className="mb-10 flex flex-col gap-4">
        <p className="label text-ref">Agent wallets · Tempo access keys</p>
        <h1 className="display text-[clamp(40px,5.4vw,76px)]">
          <span className="block">Your agents get keys.</span>
          <span className="block text-fg-3">You keep the account.</span>
        </h1>
        <p className="lede">
          Each agent signs with its own key, scoped by Tempo&rsquo;s keychain to a budget, an expiry and the Tempex escrow. Everything it does settles as you. You approve with a passkey and can revoke any key in one tap.
        </p>
      </div>
      <ConsoleLoader protocol={{ escrow: table.escrow as `0x${string}`, token: table.token as `0x${string}` }} />
    </div>
  );
}
