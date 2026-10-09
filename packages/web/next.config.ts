import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source with NodeNext-style `.js`
  // import specifiers; transpile them and let webpack resolve `.js` to `.ts`.
  transpilePackages: ['@tempex/sdk', '@tempex/arbiter'],
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = {
      ...(webpackConfig.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    // ox's virtual-address worker pool imports by expression; /play never uses it.
    webpackConfig.ignoreWarnings = [...(webpackConfig.ignoreWarnings ?? []), { module: /ox\/_esm\/tempo\/internal\/virtualMasterPool/ }];
    return webpackConfig;
  },
  // Trace from the monorepo root so workspace sources ship with the server build,
  // and keep the OG image's TTFs, which are read at runtime, in the bundle.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  outputFileTracingIncludes: { '/proof/[id]/opengraph-image': ['./app/fonts/*.ttf'] },
  poweredByHeader: false,
  // Security headers on every page. The agent console and the pairing approval
  // are where an owner signs with a passkey, so no other site may frame them
  // (clickjacking an approval is the attack to rule out), and passkeys are only
  // usable from this origin.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-create=(self), publickey-credentials-get=(self)',
          },
        ],
      },
      {
        // A delivered piece of work served as text: whatever is in it must never
        // run on this origin. Listed last so its policy replaces the one above.
        source: '/api/docs/:hash/raw',
        headers: [{ key: 'Content-Security-Policy', value: "default-src 'none'; sandbox; frame-ancestors 'none'" }],
      },
    ];
  },
};

export default config;
