'use client';
import { createContext, useContext } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

export type Me = {
  user: { id: string; name: string; avatarUrl: string | null; role: 'owner' | 'admin' | 'member'; title: string; titleTier: string; mcName: string | null; mcStatus: string; offlineUuid?: string };
  can: { manageUsers: boolean; whitelist: boolean; audit: boolean; stop: boolean; consoleHost: boolean };
};

const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;

export function MeProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  return <MeCtx.Provider value={me}>{children}</MeCtx.Provider>;
}

export function NavLinks({ showAudit }: { showAudit: boolean }) {
  const path = usePathname();
  const links: [string, string][] = [
    ['/', 'BASE CAMP'],
    ['/worlds', 'WORLDS'],
    ['/console', 'CONSOLE'],
    ['/crew', 'CREW'],
    ['/guides', 'GUIDES'],
    ...(showAudit ? ([['/audit', 'LOGBOOK']] as [string, string][]) : []),
  ];
  return (
    <nav className="nav" aria-label="Main">
      {links.map(([href, label]) => (
        <Link key={href} href={href} aria-current={(href === '/' ? path === '/' : path.startsWith(href)) ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
