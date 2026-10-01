import { keccak256, toHex, type Hex } from 'viem';

/// Most a deliverable fetch will read. Bigger work belongs behind its own URI the
/// arbiter does not need to score in full; the hash still binds it.
export const MAX_DELIVERABLE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type FetchedDeliverable = {
  uri: string;
  /// keccak256 of the raw bytes: equal to `hashText(text)` for UTF-8 text, so it
  /// compares directly with the deliverableHash a seller commits on chain
  hash: Hex;
  text: string;
  bytes: number;
};

/// Where a deliverable URI is actually read from. ipfs:// and ar:// go through
/// public gateways (overridable), so the arbiter needs no node of its own; the
/// hash check makes the gateway untrusted.
export function resolveDeliverableUri(uri: string, env: NodeJS.ProcessEnv = process.env): string {
  if (uri.startsWith('ipfs://')) {
    const gateway = env['TEMPEX_IPFS_GATEWAY']?.trim() || 'https://ipfs.io/ipfs/';
    return `${gateway.replace(/\/?$/, '/')}${uri.slice('ipfs://'.length)}`;
  }
  if (uri.startsWith('ar://')) {
    const gateway = env['TEMPEX_ARWEAVE_GATEWAY']?.trim() || 'https://arweave.net/';
    return `${gateway.replace(/\/?$/, '/')}${uri.slice('ar://'.length)}`;
  }
  if (uri.startsWith('https://') || uri.startsWith('http://') || uri.startsWith('data:')) return uri;
  throw new Error(`unsupported deliverable URI scheme: ${uri.slice(0, 32)}`);
}

/// Reads the delivered work from where the seller said it lives, capped in size
/// and time. Returns the bytes' hash so the caller decides whether to trust it:
/// only content that reproduces the on-chain deliverableHash is the real work.
export async function fetchDeliverable(
  uri: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchedDeliverable> {
  const maxBytes = options.maxBytes ?? MAX_DELIVERABLE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(resolveDeliverableUri(uri), { signal: controller.signal });
    if (!response.ok) throw new Error(`deliverable fetch answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new Error(`deliverable is ${declared} bytes, over the ${maxBytes}-byte cap`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error(`deliverable is ${body.length} bytes, over the ${maxBytes}-byte cap`);
    return {
      uri,
      hash: keccak256(toHex(body)),
      text: new TextDecoder().decode(body),
      bytes: body.length,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`deliverable fetch timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/// A self-contained URI for small text deliverables: the work rides in the
/// delivery transaction itself, so nothing has to be hosted.
export function dataUriFor(text: string): string {
  return `data:text/plain;charset=utf-8;base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}
