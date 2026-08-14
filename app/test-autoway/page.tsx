'use client';

import { JSX, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ExternalLink, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { jira } from '@/lib/services/jira';
import { IGNITE_CUSTOM_FIELDS, JIRA_ENDPOINTS } from '@/lib/constants/jira';
import {
  HMGSyncService,
  SyncLog,
  SyncLogger,
  extractAutowayKey,
} from '@/lib/services/sync';
import { JiraIssue } from '@/lib/types/jira';

const LOG_HIGHLIGHT_PATTERN =
  '(FEHG-\\d+|AUTOWAY-\\d+|성공|실패|경고|오류|에러|동기화|완료|링크|생성|업데이트)';

/** 담당자 선택용 최소 정보. 정본은 DB(`users` 테이블) → `/api/users`. */
interface UserOption {
  name: string;
  igniteAccountId: string;
}

export default function AutowayTestPage() {
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [issueInput, setIssueInput] = useState('');
  const [fehgIssue, setFehgIssue] = useState<JiraIssue | null>(null);
  const [isLoadingIssue, setIsLoadingIssue] = useState(false);
  const [isUpdatingLink, setIsUpdatingLink] = useState(false);
  const [autowayNumber, setAutowayNumber] = useState('');
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);

  const resultScrollRef = useRef<HTMLDivElement | null>(null);
  const previousLogCountRef = useRef(0);

  const currentAutowayUrl = useMemo(() => {
    if (!fehgIssue) return '';
    const link =
      (fehgIssue.fields[IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK] as
        | string
        | undefined) ?? '';
    return link || '';
  }, [fehgIssue]);

  const normalizedIssueKey = useMemo(() => {
    if (!issueInput.trim()) return '';
    const trimmed = issueInput.trim().toUpperCase();
    // PROJ-123 형식이면 그대로, 숫자만이면 FEHG- 붙임
    if (/^[A-Z]+-\d+$/.test(trimmed)) return trimmed;
    return `FEHG-${trimmed}`;
  }, [issueInput]);

  const highlightLog = (message: string) => {
    const regex = new RegExp(LOG_HIGHLIGHT_PATTERN, 'g');
    const segments: Array<string | JSX.Element> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(message)) !== null) {
      if (match.index > lastIndex) {
        segments.push(message.slice(lastIndex, match.index));
      }

      segments.push(
        <span key={`${match.index}-${match[0]}`} className="font-semibold">
          {match[0]}
        </span>
      );

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < message.length) {
      segments.push(message.slice(lastIndex));
    }

    return segments.length > 0 ? segments : [message];
  };

  useEffect(() => {
    const viewport = resultScrollRef.current?.querySelector<HTMLDivElement>(
      '[data-radix-scroll-area-viewport]'
    );

    if (!viewport) return;

    const behavior: ScrollBehavior =
      syncLogs.length > previousLogCountRef.current ? 'smooth' : 'auto';
    previousLogCountRef.current = syncLogs.length;

    const scrollToBottom = () =>
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior,
      });

    if (behavior === 'smooth') {
      requestAnimationFrame(scrollToBottom);
    } else {
      scrollToBottom();
    }
  }, [syncLogs]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/users')
      .then((res) => res.json())
      .then((json) => {
        if (cancelled || !json?.success) return;
        setUserOptions(
          (json.data as UserOption[])
            .filter((u) => u.igniteAccountId)
            .map((u) => ({ name: u.name, igniteAccountId: u.igniteAccountId }))
        );
      })
      .catch(() => {
        if (!cancelled) toast.error('사용자 목록을 불러오지 못했습니다.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!fehgIssue) {
      setAutowayNumber('');
      return;
    }

    const autowayKey = extractAutowayKey(
      (fehgIssue.fields[IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK] as
        | string
        | undefined) ?? ''
    );
    setAutowayNumber(
      autowayKey ? autowayKey.replace('AUTOWAY-', '') : (autowayKey ?? '')
    );

    if (!selectedUser && fehgIssue.fields.assignee?.accountId) {
      const matchedUser = userOptions.find(
        (user) => user.igniteAccountId === fehgIssue.fields.assignee?.accountId
      );
      if (matchedUser) {
        setSelectedUser(matchedUser.name);
      }
    }
  }, [fehgIssue, selectedUser, userOptions]);

  const handleLoadIssue = async () => {
    if (!normalizedIssueKey) {
      toast.error('FEHG 티켓 번호를 입력해주세요.');
      return;
    }

    setIsLoadingIssue(true);
    setSyncLogs([]);
    try {
      const result = await jira.ignite.getIssue(normalizedIssueKey);
      if (!result.success || !result.data) {
        throw new Error(result.error || '티켓을 불러오지 못했습니다.');
      }

      setFehgIssue(result.data);
      toast.success(`${normalizedIssueKey} 로드 완료`);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : '티켓 로드 중 오류가 발생했습니다.'
      );
      setFehgIssue(null);
    } finally {
      setIsLoadingIssue(false);
    }
  };

  const refreshIssue = async (issueKey: string) => {
    const result = await jira.ignite.getIssue(issueKey);
    if (result.success && result.data) {
      setFehgIssue(result.data);
    }
  };

  const handleUpdateLink = async () => {
    if (!fehgIssue) {
      toast.error('먼저 FEHG 티켓을 불러와주세요.');
      return;
    }

    const trimmed = autowayNumber.trim();
    if (trimmed && !/^\d+$/.test(trimmed)) {
      toast.error('AUTOWAY 티켓 번호는 숫자만 입력 가능합니다.');
      return;
    }

    setIsUpdatingLink(true);
    try {
      const linkValue = trimmed
        ? `${JIRA_ENDPOINTS.HMG}/browse/AUTOWAY-${trimmed}`
        : null;

      const result = await jira.ignite.updateIssueFields(fehgIssue.key, {
        [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: linkValue,
      });

      if (!result.success) {
        throw new Error(result.error || 'customfield_10438 업데이트 실패');
      }

      toast.success('customfield_10438 업데이트 완료');
      await refreshIssue(fehgIssue.key);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'customfield_10438 업데이트 중 오류가 발생했습니다.'
      );
    } finally {
      setIsUpdatingLink(false);
    }
  };

  const handleSyncAutoway = async () => {
    if (!fehgIssue) {
      toast.error('먼저 FEHG 티켓을 불러와주세요.');
      return;
    }

    const assigneeAccountId =
      userOptions.find((user) => user.name === selectedUser)?.igniteAccountId ??
      fehgIssue.fields.assignee?.accountId;

    if (!assigneeAccountId) {
      toast.error(
        '동기화에 사용할 담당자를 선택하거나 FEHG 티켓에 담당자가 지정되어야 합니다.'
      );
      return;
    }

    setIsSyncing(true);
    setSyncLogs([]);

    const logger = new SyncLogger((log) => {
      setSyncLogs((prev) => [...prev, log]);
    });
    const hmgSyncService = new HMGSyncService(logger);

    try {
      const result = await hmgSyncService.syncTicket(
        fehgIssue,
        assigneeAccountId
      );

      if (!result) {
        toast.warning('동기화 결과를 확인할 수 없습니다.');
      } else if (result.success) {
        toast.success(
          `${result.fehgKey} → ${result.targetKey || 'AUTOWAY'} 동기화 성공`
        );
      } else {
        toast.error(
          `${result.fehgKey} 동기화 실패: ${result.error ?? '원인 불명'}`
        );
      }

      await refreshIssue(fehgIssue.key);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : '동기화 중 오류가 발생했습니다.'
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handleReset = () => {
    setIssueInput('');
    setFehgIssue(null);
    setAutowayNumber('');
    setSelectedUser('');
    setSyncLogs([]);
  };

  return (
    <main className="min-h-screen bg-background pb-12">
      <header className="border-b">
        <div className="container mx-auto px-6 py-6">
          <h1 className="text-2xl font-bold">
            AUTOWAY 단일 티켓 동기화 테스트
          </h1>
          <p className="text-sm text-muted-foreground">
            customfield_10438을 포함한 FEHG → AUTOWAY 동기화를 개별 티켓 단위로
            안전하게 검증합니다.
          </p>
        </div>
      </header>

      <div className="container mx-auto px-6 py-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:h-[calc(100vh-200px)]">
          <Card className="flex h-full flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>테스트 설정</CardTitle>
              <CardDescription>
                FEHG 티켓 정보를 불러와 customfield_10438을 확인하고 수정할 수
                있습니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-6 overflow-y-auto pr-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">FEHG 티켓 번호</label>
                <div className="flex gap-2">
                  <Input
                    value={issueInput}
                    onChange={(e) => setIssueInput(e.target.value)}
                    placeholder="예: 2111 또는 FEHG-2111"
                    className="uppercase"
                  />
                  <Button onClick={handleLoadIssue} disabled={isLoadingIssue}>
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${
                        isLoadingIssue ? 'animate-spin' : ''
                      }`}
                    />
                    {isLoadingIssue ? '불러오는 중...' : '불러오기'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={handleReset}
                    disabled={isLoadingIssue || isSyncing || isUpdatingLink}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    초기화
                  </Button>
                </div>
              </div>

              {fehgIssue && (
                <div className="space-y-6 rounded-lg border p-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold">
                      {fehgIssue.key}{' '}
                      <a
                        href={`${JIRA_ENDPOINTS.IGNITE}/browse/${fehgIssue.key}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                      >
                        원본 보기
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {fehgIssue.fields.summary}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        담당자 (Ignite)
                      </p>
                      <p className="text-sm">
                        {fehgIssue.fields.assignee?.displayName ||
                          '지정되지 않음'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        상태
                      </p>
                      <p className="text-sm">
                        {fehgIssue.fields.status?.name || '알 수 없음'}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      동기화 담당자 선택 (옵션)
                    </label>
                    <Select
                      value={selectedUser}
                      onValueChange={setSelectedUser}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="동기화에 사용할 담당자를 선택 (미선택 시 티켓 담당자 사용)" />
                      </SelectTrigger>
                      <SelectContent>
                        {userOptions.map((user) => (
                          <SelectItem
                            key={user.igniteAccountId}
                            value={user.name}
                          >
                            {user.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3 rounded-md border border-dashed p-4">
                    <p className="text-sm font-semibold">customfield_10438</p>
                    <p className="text-xs text-muted-foreground">
                      AUTOWAY 티켓 URL이 저장되는 필드입니다. 값이 없거나 예전
                      URL이면 동기화 시 AUTOWAY 티켓이 새로 생성됩니다.
                    </p>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        현재 저장된 값
                      </label>
                      <p className="rounded bg-muted px-3 py-2 text-xs font-mono">
                        {currentAutowayUrl || '값이 없습니다.'}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        AUTOWAY 티켓 번호 (숫자만 입력)
                      </label>
                      <Input
                        value={autowayNumber}
                        onChange={(e) =>
                          setAutowayNumber(
                            e.target.value.replace(/[^0-9]/g, '')
                          )
                        }
                        placeholder="예: 1234 → https://hmg.atlassian.net/browse/AUTOWAY-1234"
                      />
                      <Button
                        onClick={handleUpdateLink}
                        disabled={isUpdatingLink}
                        className="w-full"
                        variant="secondary"
                      >
                        <Save
                          className={`mr-2 h-4 w-4 ${
                            isUpdatingLink ? 'animate-spin' : ''
                          }`}
                        />
                        {isUpdatingLink
                          ? '업데이트 중...'
                          : 'customfield_10438 저장'}
                      </Button>
                    </div>
                  </div>

                  <Button
                    onClick={handleSyncAutoway}
                    disabled={isSyncing}
                    className="w-full"
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`}
                    />
                    {isSyncing ? '동기화 중...' : 'AUTOWAY 동기화 실행'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="flex h-full flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>실행 로그</CardTitle>
              <CardDescription>
                HMGSyncService가 남기는 실시간 로그를 확인하세요.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden">
              <ScrollArea ref={resultScrollRef} className="h-full px-6 pb-6">
                <div className="space-y-3 font-mono text-sm leading-relaxed">
                  {syncLogs.length === 0 ? (
                    <div className="text-muted-foreground">
                      <p>[00:00:00] 로그가 아직 없습니다.</p>
                      <p>
                        티켓을 불러오고 동기화를 실행하면 로그가 표시됩니다.
                      </p>
                    </div>
                  ) : (
                    syncLogs.map((log, idx) => (
                      <div
                        key={idx}
                        className={`${
                          log.level === 'success'
                            ? 'text-green-600'
                            : log.level === 'error'
                              ? 'text-red-600'
                              : log.level === 'warning'
                                ? 'text-yellow-600'
                                : 'text-blue-600'
                        }`}
                      >
                        <span className="text-muted-foreground">
                          [{log.timestamp}]
                        </span>{' '}
                        <span className="whitespace-pre-wrap">
                          {highlightLog(log.message)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
