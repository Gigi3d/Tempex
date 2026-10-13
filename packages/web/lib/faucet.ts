/// Testnet funds: Tempo's own faucet first, then the site's house faucet if
/// Tempo's is down (it has answered "request too large" to every call before).
export async function requestTestnetFunds(client: { fundWithFaucet(): Promise<unknown> }, address: string): Promise<void> {
  try {
    await client.fundWithFaucet();
    return;
  } catch (tempoError) {
    const response = await fetch('/api/faucet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    }).catch(() => null);
    if (response?.ok) return;
    const reason = response ? ((await response.json().catch(() => null)) as { message?: string } | null)?.message : null;
    throw new Error(reason ?? `The testnet faucet is unavailable: ${(tempoError as Error).message}`);
  }
}
