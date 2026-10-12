import { PlayLoader } from '@/components/play-loader';
import { tableConfig } from '@/lib/court';
import { snapshot } from '@/lib/snapshot';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Sandbox',
  description: 'Strike a real deal on Tempo from your browser: escrow it, dispute it, and watch it settle by rule.',
};

export default async function PlayPage() {
  const table = await tableConfig();
  // Scenarios with nothing delivered still play: Bolt delivers an empty file.
  const scenarios = snapshot.corpus;
  return (
    <div className="wrap pt-10 pb-24">
      <div className="mb-10 flex flex-col gap-4">
        <p className="label text-ref">Sandbox · real deals on Moderato testnet</p>
        <h1 className="display text-[clamp(40px,5.4vw,76px)]">
          <span className="block">Strike a deal.</span>
          <span className="block text-fg-3">Break it. Get a fair ruling.</span>
        </h1>
        <p className="lede">
          Every step is a real transaction on Tempo&rsquo;s testnet, signed in this browser. No wallet to install, no gas to buy: a passkey signs, the faucet funds and the sponsor pays the fees.
        </p>
      </div>
      {table.escrow ? (
        <PlayLoader table={{ escrow: table.escrow as `0x${string}`, token: table.token as `0x${string}`, arbiter: table.arbiter as `0x${string}` | null, court: table.court }} scenarios={scenarios} />
      ) : (
        <p className="panel p-6 text-fail">This site has no escrow address. Set TEMPEX_ESCROW or bake a snapshot with the beacon up.</p>
      )}
    </div>
  );
}
