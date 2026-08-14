'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Home, Users, FolderKanban, Layers, GitCompareArrows } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/settings/teams', label: '팀 관리', icon: Layers },
  { href: '/settings/users', label: '사용자 관리', icon: Users },
  { href: '/settings/projects', label: '프로젝트 관리', icon: FolderKanban },
  { href: '/settings/field-mappings', label: '동기화 방식 관리', icon: GitCompareArrows },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">설정</h1>
            <p className="text-sm text-muted-foreground">
              팀, 사용자, 프로젝트를 관리합니다
            </p>
          </div>
          <Link href="/">
            <Button variant="outline">
              <Home className="mr-2 h-4 w-4" />
              홈으로
            </Button>
          </Link>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-56 border-r p-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <Button
                  variant={isActive ? 'secondary' : 'ghost'}
                  className={cn('w-full justify-start', isActive && 'font-semibold')}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {item.label}
                </Button>
              </Link>
            );
          })}
        </nav>

        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
