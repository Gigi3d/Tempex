'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/// Phone-width navigation: a hand-drawn burger that opens a plain list of every page.

export function MobileMenu({ items }: { items: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((v) => !v)}
        className="-mr-2 flex h-11 w-11 items-center justify-center text-fg"
      >
        <Burger open={open} />
      </button>
      {open ? (
        <nav
          id="mobile-menu"
          aria-label="Main"
          className="absolute inset-x-0 top-full z-30 h-[calc(100dvh-4rem)] overflow-y-auto border-t hairline bg-ink"
        >
          <ul className="wrap flex flex-col py-4">
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-3 border-b hairline py-4 text-[20px] ${active ? 'text-fg' : 'text-fg-2'}`}
                  >
                    {active ? <Tick /> : <span className="w-[18px]" />}
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="wrap pb-8">
            <Link href="/agents" className="btn btn-primary w-full justify-center">
              Give an agent a key
            </Link>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

const WOBBLE = 'mm-wobble';

function Burger({ open }: { open: boolean }) {
  const line = { transition: 'transform 200ms ease, opacity 150ms ease', transformOrigin: '20px 20px' };
  return (
    <svg width="28" height="28" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" aria-hidden>
      <defs>
        <filter id={WOBBLE} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves={2} seed={7} />
          <feDisplacementMap in="SourceGraphic" scale={2.5} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g filter={`url(#${WOBBLE})`}>
        <path d="M8 11 Q20 9.5 32 11.5" style={{ ...line, transform: open ? 'translateY(9px) rotate(45deg)' : 'none' }} />
        <path d="M9 20.5 Q19 19 31 20" stroke="#4be3a5" style={{ ...line, opacity: open ? 0 : 1 }} />
        <path d="M8 29.5 Q21 28 32 29" style={{ ...line, transform: open ? 'translateY(-9px) rotate(-45deg)' : 'none' }} />
      </g>
    </svg>
  );
}

function Tick() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="#4be3a5" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 10.5 Q6 12.5 8 15 Q11.5 8 16.5 4.5" filter={`url(#${WOBBLE})`} />
    </svg>
  );
}
