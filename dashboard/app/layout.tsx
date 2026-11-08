import type { Metadata, Viewport } from 'next';
import { Press_Start_2P, Pixelify_Sans, VT323 } from 'next/font/google';
import { connection } from 'next/server';
import { Sky } from '@/components/pixel';
import './globals.css';

// All three are SIL Open Font License 1.1 fonts. next/font downloads them at build time and
// serves them from our own domain, so visitors' browsers never contact Google.
const display = Press_Start_2P({ weight: '400', subsets: ['latin'], variable: '--font-press-start', display: 'swap' });
const body = Pixelify_Sans({ subsets: ['latin'], variable: '--font-pixelify', display: 'swap' });
const mono = VT323({ weight: '400', subsets: ['latin'], variable: '--font-vt323', display: 'swap' });

export const metadata: Metadata = {
  title: 'Hop On SMP',
  description: 'Control panel for the Hop On SMP Minecraft server',
  robots: { index: false, follow: false },
  referrer: 'strict-origin-when-cross-origin',
};

export const viewport: Viewport = { themeColor: '#0e0c18', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection(); // every page is rendered per request, so the CSP nonce applies
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Sky />
        {children}
      </body>
    </html>
  );
}
