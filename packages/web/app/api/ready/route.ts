import { NextResponse } from 'next/server';

import { getReady } from '@/lib/beacon';

/// Proxies the beacon's /ready so the browser never needs the beacon's address.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get('address') ?? '';
  const role = url.searchParams.get('role') === 'buyer' ? 'buyer' : 'seller';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Enter a 0x address: 40 hex characters after 0x.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await getReady(address, role));
  } catch (error) {
    return NextResponse.json({ error: `The beacon did not answer (${(error as Error).message}). Try again in a moment.` }, { status: 502 });
  }
}
