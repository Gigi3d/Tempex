import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { P256, PublicKey } from 'ox';
import { getAddress, type Address, type Hex } from 'viem';

import { keyIdOf, type AgentRole } from '@tempex/sdk';

/// The agent's identity on disk: a P-256 key that Tempo's keychain can authorize
/// under an owner's account. The private key is generated here and never sent
/// anywhere; pairing shares only the public key.
///
/// Stored with owner-only permissions, and encrypted (scrypt + AES-256-GCM) when
/// TEMPEX_AGENT_PASSPHRASE is set. In a container, skip the file entirely and
/// inject TEMPEX_AGENT_PRIVATE_KEY and TEMPEX_AGENT_OWNER from a secret store.

export type Sealed = { kdf: 'scrypt'; n: number; r: number; p: number; salt: Hex; iv: Hex; tag: Hex; ciphertext: Hex };

export type AgentFile = {
  version: 1;
  name: string;
  role: AgentRole;
  keyId: Address;
  publicKey: Hex;
  /// Exactly one of these holds the private key.
  privateKey?: Hex;
  sealed?: Sealed;
  createdAt: string;
  /// Set once an owner has authorized this key on chain.
  owner?: Address;
  pairing?: { code: string; tx: Hex; approvedAt: string; beacon: string };
};

export type Agent = Omit<AgentFile, 'privateKey' | 'sealed'> & { privateKey: Hex; file: string | null };

const SCRYPT = { n: 1 << 15, r: 8, p: 1 } as const;

export function defaultAgentFile(): string {
  return process.env['TEMPEX_AGENT_FILE'] ?? join(process.env['TEMPEX_AGENT_HOME'] ?? join(homedir(), '.tempex'), 'agent.json');
}

export function createAgent(params: { name: string; role: AgentRole; file?: string; passphrase?: string; force?: boolean }): Agent {
  const file = params.file ?? defaultAgentFile();
  if (existsSync(file) && !params.force) {
    throw new Error(`${file} already holds an agent key; pass --force to replace it (the old key stays authorized until its owner revokes it)`);
  }
  const privateKey = P256.randomPrivateKey();
  const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
  const agent: AgentFile = {
    version: 1,
    name: params.name,
    role: params.role,
    keyId: keyIdOf(publicKey),
    publicKey,
    ...(params.passphrase ? { sealed: seal(privateKey, params.passphrase) } : { privateKey }),
    createdAt: new Date().toISOString(),
  };
  writeAgentFile(file, agent);
  return { ...publicPart(agent), privateKey, file };
}

/// The agent from the environment if it is there, else from its file.
export function loadAgent(params: { file?: string; passphrase?: string } = {}): Agent {
  const injected = process.env['TEMPEX_AGENT_PRIVATE_KEY'];
  if (injected) {
    const privateKey = injected as Hex;
    const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
    const owner = process.env['TEMPEX_AGENT_OWNER'];
    return {
      version: 1,
      name: process.env['TEMPEX_AGENT_NAME'] ?? 'agent',
      role: (process.env['TEMPEX_AGENT_ROLE'] as AgentRole | undefined) ?? 'both',
      keyId: keyIdOf(publicKey),
      publicKey,
      createdAt: new Date(0).toISOString(),
      ...(owner ? { owner: getAddress(owner) } : {}),
      privateKey,
      file: null,
    };
  }
  const file = params.file ?? defaultAgentFile();
  if (!existsSync(file)) throw new Error(`no agent at ${file}; run \`tempex-agent init\` first`);
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} is readable by other users; run \`chmod 600 ${file}\``);
  }
  const stored = JSON.parse(readFileSync(file, 'utf8')) as AgentFile;
  let privateKey = stored.privateKey;
  if (stored.sealed) {
    const passphrase = params.passphrase ?? process.env['TEMPEX_AGENT_PASSPHRASE'];
    if (!passphrase) throw new Error('this agent key is encrypted; set TEMPEX_AGENT_PASSPHRASE');
    privateKey = unseal(stored.sealed, passphrase);
  }
  if (!privateKey) throw new Error(`${file} holds no private key`);
  if (keyIdOf(PublicKey.toHex(P256.getPublicKey({ privateKey }))) !== getAddress(stored.keyId)) {
    throw new Error(`${file} is inconsistent: its private key does not match its key id`);
  }
  return { ...publicPart(stored), privateKey, file };
}

/// Records the owner once the agent has verified its authorization on chain.
export function saveOwner(agent: Agent, owner: Address, pairing: NonNullable<AgentFile['pairing']>): Agent {
  if (!agent.file) return { ...agent, owner, pairing };
  const stored = JSON.parse(readFileSync(agent.file, 'utf8')) as AgentFile;
  const next: AgentFile = { ...stored, owner, pairing };
  writeAgentFile(agent.file, next);
  return { ...agent, owner, pairing };
}

function publicPart(file: AgentFile): Omit<AgentFile, 'privateKey' | 'sealed'> {
  const { privateKey: _secret, sealed: _sealed, ...rest } = file;
  return rest;
}

function writeAgentFile(file: string, agent: AgentFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(agent, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

export function seal(privateKey: Hex, passphrase: string): Sealed {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), 'hex')), cipher.final()]);
  const hex = (b: Buffer): Hex => `0x${b.toString('hex')}`;
  return { kdf: 'scrypt', ...SCRYPT, salt: hex(salt), iv: hex(iv), tag: hex(cipher.getAuthTag()), ciphertext: hex(ciphertext) };
}

export function unseal(sealed: Sealed, passphrase: string): Hex {
  const buf = (h: Hex): Buffer => Buffer.from(h.slice(2), 'hex');
  const key = scryptSync(passphrase, buf(sealed.salt), 32, { N: sealed.n, r: sealed.r, p: sealed.p, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', key, buf(sealed.iv));
  decipher.setAuthTag(buf(sealed.tag));
  try {
    return `0x${Buffer.concat([decipher.update(buf(sealed.ciphertext)), decipher.final()]).toString('hex')}`;
  } catch {
    throw new Error('wrong passphrase, or the key file was altered');
  }
}
