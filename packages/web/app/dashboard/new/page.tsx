import type { Address } from 'viem';

import { NewJobLoader } from '@/components/desk/loaders';
import { getArbiters, getManifest } from '@/lib/beacon';
import { tableConfig } from '@/lib/court';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Open a job', description: 'Write the terms, name a seller and fund it in one passkey prompt.' };

type ManifestProtocol = {
  protocol?: {
    fees?: { platformBps?: number };
    guards?: { maxJobAmount?: string; arbitrationFeeFloor?: string; referralShareBps?: number } | null;
  };
};

export default async function NewJobPage() {
  const [table, arbiters, manifest] = await Promise.all([tableConfig(), getArbiters().catch(() => null), getManifest().catch(() => null)]);
  const protocol = (manifest?.data as ManifestProtocol | undefined)?.protocol;
  const house = arbiters?.data.house;
  const max = protocol?.guards?.maxJobAmount;
  return (
    <div className="wrap pt-10 pb-24">
      <div className="mb-10 flex flex-col gap-4">
        <p className="label text-ref">Open a job</p>
        <h1 className="display text-[clamp(36px,4.8vw,64px)]">
          <span className="block">Write it down once.</span>
          <span className="block text-fg-3">The escrow holds both sides to it.</span>
        </h1>
      </div>
      <NewJobLoader
        context={{
          protocol: { escrow: table.escrow as Address, token: table.token as Address },
          platformFeeBps: protocol?.fees?.platformBps ?? 50,
          house: { arbiter: (house?.arbiter ?? table.arbiter ?? table.escrow) as Address, feeBps: house?.feeBps ?? 200 },
          listed: (arbiters?.data.listed ?? []).filter((entry) => entry.active).map((entry) => ({ arbiter: entry.arbiter as Address, feeBps: entry.feeBps, metadataURI: entry.metadataURI, ruled: entry.record.ruled })),
          maxJobAmount: max && BigInt(max) < 2n ** 255n ? max : null,
          arbitrationFeeFloor: protocol?.guards?.arbitrationFeeFloor ?? null,
          referralShareBps: protocol?.guards?.referralShareBps ?? 2000,
        }}
      />
    </div>
  );
}
