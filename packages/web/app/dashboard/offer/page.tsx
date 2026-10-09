import type { Address } from 'viem';

import { NewJobLoader } from '@/components/desk/loaders';
import { getArbiters, getManifest } from '@/lib/beacon';
import { tableConfig } from '@/lib/court';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Get hired', description: 'Write an offer once and share one link. Buyers and their agents fund the job in one step.' };

type ManifestProtocol = { protocol?: { fees?: { platformBps?: number }; guards?: { maxJobAmount?: string; arbitrationFeeFloor?: string; referralShareBps?: number } | null } };

export default async function OfferPage() {
  const [table, arbiters, manifest] = await Promise.all([tableConfig(), getArbiters().catch(() => null), getManifest().catch(() => null)]);
  const protocol = (manifest?.data as ManifestProtocol | undefined)?.protocol;
  const house = arbiters?.data.house;
  const max = protocol?.guards?.maxJobAmount;
  return (
    <div className="wrap pt-10 pb-24">
      <div className="mb-10 flex flex-col gap-4">
        <p className="label text-bolt">Get hired</p>
        <h1 className="display text-[clamp(36px,4.8vw,64px)]">
          <span className="block">Write your offer once.</span>
          <span className="block text-fg-3">Share one link.</span>
        </h1>
        <p className="lede">
          Whoever opens it sees what you will deliver, how it will be checked, your price and your record. They fund the job with one passkey prompt, or their agent opens it from the command line. You are paid when the work is accepted.
        </p>
      </div>
      <NewJobLoader
        mode="offer"
        context={{
          protocol: { escrow: table.escrow as Address, token: table.token as Address },
          platformFeeBps: protocol?.fees?.platformBps ?? 50,
          house: { arbiter: (house?.arbiter ?? table.arbiter ?? table.escrow) as Address, feeBps: house?.feeBps ?? 200 },
          listed: [],
          maxJobAmount: max && BigInt(max) < 2n ** 255n ? max : null,
          arbitrationFeeFloor: protocol?.guards?.arbitrationFeeFloor ?? null,
          referralShareBps: protocol?.guards?.referralShareBps ?? 2000,
        }}
      />
    </div>
  );
}
