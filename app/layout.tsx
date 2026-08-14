import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/toaster';
import { UserProvider } from '@/contexts/user-context';
import { GlobalHeaderStrip } from '@/components/global-header-strip';
import { TokenExpiredDialog } from '@/components/token-expired-dialog';

export const metadata: Metadata = {
  title: 'FE1 Jira 통합 관리',
  description: '이그나이트 FE1 팀 Jira 자동화 및 통합 관리 도구',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <UserProvider>
          <GlobalHeaderStrip />
          {children}
          <TokenExpiredDialog />
          <Toaster />
        </UserProvider>
      </body>
    </html>
  );
}
