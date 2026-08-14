'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { AlertTriangle, UserRoundCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/contexts/user-context';
import { db } from '@/lib/db';

interface Warning {
  message: string;
  detail?: string;
  href: string;
  linkLabel: string;
  /** 해당 설정 페이지에서는 워닝을 숨김 */
  hideOnPath?: string;
}

export function GlobalHeaderStrip() {
  const { currentUser } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const [hasSyncTargets, setHasSyncTargets] = useState<boolean | null>(null);

  // 동기화 대상 존재 여부 조회
  useEffect(() => {
    if (!currentUser?.teamId) {
      // 팀이 없으면 "조회 안 됨"(null) 으로 되돌린다. 사용자 전환 시 이전 팀의 결과가 남지 않게 하는 초기화다.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- currentUser 변경에 따른 상태 초기화
      setHasSyncTargets(null);
      return;
    }

    db
      .from('team_target_projects')
      .select('sync_profile_id')
      .eq('team_id', currentUser.teamId)
      .not('sync_profile_id', 'is', null)
      .limit(1)
      .then(({ data }) => {
        setHasSyncTargets(!!data && data.length > 0);
      });
  }, [currentUser?.teamId]);

  if (pathname === '/select-user') return null;
  if (!currentUser) return null;

  const handleSwitchUser = () => {
    router.push('/select-user?switch=true');
  };

  // 우선순위별 워닝 판별 — 가장 높은 것 하나만 표시
  const warning = resolveWarning(currentUser, hasSyncTargets, pathname);

  return (
    <div
      className={`sticky top-0 z-50 border-b px-4 py-1.5 ${
        warning
          ? 'bg-amber-50 border-amber-200/60'
          : 'bg-background/95 backdrop-blur-sm'
      }`}
    >
      <div className="container mx-auto flex items-center justify-between gap-3">
        {/* 왼쪽: 워닝 */}
        <div className="flex items-center gap-2 min-w-0">
          {warning && (
            <>
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-xs font-medium text-amber-800 truncate">
                {warning.message}
              </span>
              {warning.detail && (
                <span className="text-xs text-amber-600/80 hidden sm:inline truncate">
                  {warning.detail}
                </span>
              )}
              <Link
                href={warning.href}
                className="text-xs font-medium text-amber-900 hover:text-amber-700 underline underline-offset-2 shrink-0"
              >
                {warning.linkLabel}
              </Link>
            </>
          )}
        </div>

        {/* 오른쪽: 사용자 정보 + 변경 */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 shrink-0"
          onClick={handleSwitchUser}
        >
          <UserRoundCog className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{currentUser.name}</span>
          {currentUser.teamName && (
            <span className="ml-0.5 text-[11px] text-muted-foreground/50">
              ({currentUser.teamName})
            </span>
          )}
          <span className="ml-1 text-[11px] text-muted-foreground/40">변경</span>
        </Button>
      </div>
    </div>
  );
}

function resolveWarning(
  user: NonNullable<ReturnType<typeof useCurrentUser>['currentUser']>,
  hasSyncTargets: boolean | null,
  pathname: string | null
): Warning | null {
  const warnings: Warning[] = [];

  // 1. 소속 팀 없음
  if (!user.teamId) {
    warnings.push({
      message: '소속 팀 설정이 필요합니다',
      href: `/settings/users?setup=${user.id}`,
      linkLabel: '사용자 설정',
      hideOnPath: '/settings/users',
    });
  }

  // 2. API Key 인증 없음
  const credentialMissing = !user.hasIgniteCredentials || !user.hasHmgCredentials;

  if (credentialMissing) {
    warnings.push({
      message: 'API Key 인증이 필요합니다',
      detail: '미인증 시 동기화 등 주요 기능을 사용할 수 없습니다',
      href: `/settings/users?setup=${user.id}`,
      linkLabel: '사용자 설정',
      hideOnPath: '/settings/users',
    });
  }

  // 3. 기준 프로젝트 없음 (팀은 있지만 기준 프로젝트 미설정)
  if (user.teamId && !user.sourceProject) {
    warnings.push({
      message: '소속 팀의 기준 프로젝트 설정이 필요합니다',
      href: '/settings/teams',
      linkLabel: '팀 설정',
      hideOnPath: '/settings/teams',
    });
  }

  // 4. 동기화 방식 없음 (팀, 기준 프로젝트 있지만 동기화 대상 없음)
  if (user.teamId && user.sourceProject && hasSyncTargets === false) {
    warnings.push({
      message: '동기화 방식 추가가 필요합니다',
      href: '/settings/field-mappings',
      linkLabel: '동기화 설정',
      hideOnPath: '/settings/field-mappings',
    });
  }

  // 가장 높은 우선순위 워닝 중 현재 페이지에서 숨기지 않는 첫 번째 반환
  for (const w of warnings) {
    if (w.hideOnPath && pathname?.startsWith(w.hideOnPath)) continue;
    return w;
  }

  return null;
}
