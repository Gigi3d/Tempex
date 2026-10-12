import Link from 'next/link';

import { CHAIN_ID, EXPLORER_URL } from '@tempex/sdk/browser';

import { beaconUrl } from '@/lib/beacon';
import { snapshot } from '@/lib/snapshot';

import { InboxBadge } from './desk/inbox-badge';
import { MobileMenu } from './mobile-menu';
import { Hash, Wordmark } from './ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/demo', label: 'Demo' },
  { href: '/play', label: 'Sandbox' },
  { href: '/agents', label: 'Agents' },
  { href: '/cases', label: 'Cases' },
  { href: '/explorer', label: 'Explorer' },
  { href: '/arbiters', label: 'Arbiters' },
  { href: '/console', label: 'Console' },
];

export function Header() {
  return (
    <header className="border-b hairline bg-ink/80 backdrop-blur sticky top-0 z-30">
      <div className="wrap flex h-16 items-center gap-6">
        <Link href="/" aria-label="Tempex home" className="shrink-0">
          <Wordmark />
        </Link>
        <nav aria-label="Main" className="ml-auto hidden min-w-0 items-center gap-1 text-[14px] text-fg-2 md:flex">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="inline-flex shrink-0 items-center px-3 py-2 transition-colors hover:text-fg">
              {item.label}
              {item.href === '/dashboard' ? <InboxBadge /> : null}
            </Link>
          ))}
        </nav>
        <div className="ml-auto md:hidden">
          <MobileMenu items={NAV} />
        </div>
        <Link href="/agents" className="btn btn-primary hidden md:inline-flex">
          Give an agent a key
        </Link>
      </div>
    </header>
  );
}

export function Footer() {
  const escrow = snapshot.receipt.escrow;
  return (
    <footer className="mt-24 border-t hairline">
      <div className="wrap grid gap-8 py-12 md:grid-cols-[1.2fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Wordmark size={18} />
          <p className="max-w-sm text-[14px] text-fg-3">
            Settlement infrastructure for the agent economy: payment, proof of delivery and bounded dispute settlement in one contract, in stablecoins on Tempo.
          </p>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          <dt className="label self-center">escrow</dt>
          <dd>
            <Hash value={escrow} kind="address" />
          </dd>
          <dt className="label self-center">chain</dt>
          <dd className="font-mono text-fg-2">{CHAIN_ID} · Moderato testnet</dd>
          <dt className="label self-center">beacon</dt>
          <dd className="font-mono text-fg-2 break-all">{beaconUrl() ?? 'snapshot only'}</dd>
        </dl>
        <div className="flex flex-col gap-2 text-[14px] text-fg-2">
          <a className="link w-fit" href={`${EXPLORER_URL}/address/${escrow}`} target="_blank" rel="noreferrer">
            Contract on the explorer
          </a>
          <a className="link w-fit" href="https://github.com/Gigi3d/Tempex" target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
          <Link className="link w-fit" href="/console">
            Machine interface
          </Link>
          <p className="mt-2 text-[12px] text-fg-3">MIT licensed · built on Tempo</p>
        </div>
      </div>
    </footer>
  );
}
