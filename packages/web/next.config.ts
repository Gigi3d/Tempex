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
};

export default config;
