import Link from 'next/link';

import { Ref } from '@/components/characters';

export default function NotFound() {
  return (
    <div className="wrap flex flex-col items-start gap-6 pt-24">
      <Ref id="nf-ref" size={120} mood="listening" />
      <p className="label">404</p>
      <h1 className="display text-[clamp(40px,5vw,64px)]">Ref looked. Nothing is here.</h1>
      <p className="lede">The page or job you asked for doesn’t exist. Job ids are whole numbers; the explorer lists every one the escrow has seen.</p>
      <div className="flex gap-3">
        <Link href="/explorer" className="btn btn-primary">Open the explorer</Link>
        <Link href="/" className="btn">Home</Link>
      </div>
    </div>
  );
}
