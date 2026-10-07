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
    return webpackConfig;
  },
  poweredByHeader: false,
};

export default config;
