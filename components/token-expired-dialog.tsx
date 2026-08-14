'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { JIRA_TOKEN_EXPIRED_EVENT } from '@/lib/services/jira/client';

const INSTANCE_LABEL: Record<'ignite' | 'hmg', string> = {
  ignite: 'Ignite Jira',
  hmg: 'HMG Jira',
};

/**
 * Jira API 토큰이 만료/무효화되면 (프록시 401 → client.ts 이벤트) 전역 팝업으로 안내한다.
 * 동기화 중 401이 연속으로 발생해도, 팝업이 이미 열려 있으면 무시해 한 번만 표시한다.
 */
export function TokenExpiredDialog() {
  const [open, setOpen] = useState(false);
  const [instance, setInstance] = useState<'ignite' | 'hmg' | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ instance: 'ignite' | 'hmg' }>).detail;
      // 이미 열려 있으면 dedupe (동기화 중 다수의 401이 몰려도 팝업은 하나만)
      setOpen((alreadyOpen) => {
        if (!alreadyOpen && detail?.instance) {
          setInstance(detail.instance);
        }
        return true;
      });
    };

    window.addEventListener(JIRA_TOKEN_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(JIRA_TOKEN_EXPIRED_EVENT, handler);
  }, []);

  const label = instance ? INSTANCE_LABEL[instance] : 'Jira';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Jira 토큰이 만료되었습니다
          </DialogTitle>
          <DialogDescription>
            {label} API 토큰이 만료되었거나 유효하지 않아 동기화가 중단되었습니다.
            사용자 설정에서 API Key를 다시 등록한 뒤 동기화를 재시도해주세요.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            닫기
          </Button>
          <Button
            onClick={() => {
              setOpen(false);
              window.location.href = '/settings/users';
            }}
          >
            설정으로 이동
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
