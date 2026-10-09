import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { Footer, Header } from '@/components/shell';

import './globals.css';

const site =
  process.env['NEXT_PUBLIC_SITE_URL'] ??
  (process.env['VERCEL_PROJECT_PRODUCTION_URL'] ? `https://${process.env['VERCEL_PROJECT_PRODUCTION_URL']}` : 'http://localhost:3000');

export const metadata: Metadata = {
  metadataBase: new URL(site),
  title: { default: 'Tempex · bounded autonomy for agent commerce', template: '%s · Tempex' },
  description: 'Your agents spend inside limits you set: budgeted Tempo keys, escrow until the work is delivered, and a referee that can only rule inside the range both offers allow.',
  openGraph: { type: 'website', siteName: 'Tempex' },
  twitter: { card: 'summary_large_image' },
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = { themeColor: '#0c0c0d', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 btn btn-primary">
          Skip to content
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
