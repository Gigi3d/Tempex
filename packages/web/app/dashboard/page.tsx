import { DashboardLoader } from '@/components/desk/loaders';
import { tableConfig } from '@/lib/court';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Dashboard',
  description: 'Your jobs on both sides, what needs you next, and everything your agents signed for you.',
};

export default async function DashboardPage() {
  const table = await tableConfig();
  return (
    <div className="wrap pt-10 pb-24">
      <div className="mb-10 flex flex-col gap-4">
        <p className="label text-ref">Dashboard · your account on Tempex</p>
        <h1 className="display text-[clamp(40px,5.4vw,76px)]">
          <span className="block">Every deal you are in.</span>
          <span className="block text-fg-3">And every step your agents took.</span>
        </h1>
      </div>
      <DashboardLoader protocol={{ escrow: table.escrow as `0x${string}`, token: table.token as `0x${string}` }} />
    </div>
  );
}
