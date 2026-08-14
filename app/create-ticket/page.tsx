'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { jiraFetch } from '@/lib/jira-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  Plus,
  ExternalLink,
  Copy,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { useCurrentUser } from '@/contexts/user-context';
import { jira } from '@/lib/services/jira';
import { JiraIssue } from '@/lib/types/jira';
import { SyncOrchestrator } from '@/lib/services/sync';

export default function CreateTicketPage() {
  const { currentUser } = useCurrentUser();

  // 에픽 목록
  const [fehgEpics, setFehgEpics] = useState<JiraIssue[]>([]);
  const [isLoadingEpics, setIsLoadingEpics] = useState(false);

  // 입력 필드
  const [selectedEpic, setSelectedEpic] = useState<string>('');
  const [summary, setSummary] = useState<string>('');
  const [estimatedTime, setEstimatedTime] = useState<string>('');
  const [estimatedTimeError, setEstimatedTimeError] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [relatedLink, setRelatedLink] = useState<string>('');

  // 생성 상태
  const [isCreating, setIsCreating] = useState(false);
  const [createdTicketKey, setCreatedTicketKey] = useState<string>('');
  const [createdTicketSummary, setCreatedTicketSummary] = useState<string>('');

  // 동기화 상태
  const [isSyncingTicket, setIsSyncingTicket] = useState(false);

  // 소속팀 기준 프로젝트 키
  const sourceProject = currentUser?.sourceProject || 'FEHG';

  // 기준 프로젝트의 완료되지 않은 에픽 조회 (페이지 로드 시)
  useEffect(() => {
    const loadEpics = async () => {
      setIsLoadingEpics(true);
      try {
        const result = await jira.ignite.getFEHGIncompleteEpics(sourceProject);
        if (result.success && result.data) {
          setFehgEpics(result.data.issues);
        } else {
          toast.error('에픽 목록을 불러올 수 없습니다.');
        }
      } catch {
        toast.error('에픽 조회 중 오류가 발생했습니다.');
      } finally {
        setIsLoadingEpics(false);
      }
    };

    loadEpics();
  }, [sourceProject]);

  // 최초추정치 유효성 검증 (예: 3d, 1m, 2w, 1.5h)
  const validateEstimatedTime = (value: string): boolean => {
    if (!value.trim()) return false;
    const pattern = /^(\d+\.?\d*)(d|m|w|h)$/i;
    return pattern.test(value.trim());
  };

  // 최초추정치 입력 핸들러
  const handleEstimatedTimeInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setEstimatedTime(value);

    // 실시간 유효성 검증
    if (value.trim() && !validateEstimatedTime(value)) {
      setEstimatedTimeError('형식이 올바르지 않습니다 (예: 3d, 1m, 2w, 1.5h)');
    } else {
      setEstimatedTimeError('');
    }
  };

  const handleCreateTicket = async () => {
    // 필수값 검증
    if (!selectedEpic) {
      toast.error('상위 에픽을 선택해주세요.');
      return;
    }
    if (!summary.trim()) {
      toast.error('티켓 제목을 입력해주세요.');
      return;
    }
    if (!currentUser) {
      toast.error('사용자가 선택되지 않았습니다.');
      return;
    }
    // 최초추정치 입력했으면 형식 검증
    if (estimatedTime.trim() && !validateEstimatedTime(estimatedTime)) {
      toast.error('최초추정치 형식이 올바르지 않습니다. (예: 3d, 1m, 2w)');
      return;
    }

    setIsCreating(true);
    setCreatedTicketKey('');
    setCreatedTicketSummary('');

    try {

      toast.info(`"${summary}" 티켓 생성을 시작합니다...`);

      // 티켓 생성 payload (필수 필드)
      const fields: Record<string, unknown> = {
        project: { key: sourceProject },
        summary,
        issuetype: { name: '작업' },
        parent: { key: selectedEpic }, // Epic Link
        assignee: { accountId: currentUser.igniteAccountId },
      };

      // 선택 필드 추가
      if (startDate) {
        fields.customfield_10015 = startDate; // 시작일
      }
      if (endDate) {
        fields.duedate = endDate; // 종료일
      }
      if (estimatedTime.trim()) {
        fields.timetracking = {
          originalEstimate: estimatedTime.trim(),
        };
      }
      if (relatedLink.trim()) {
        fields.description = {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: `관련 업무: ${relatedLink.trim()}`,
                },
              ],
            },
          ],
        };
      }

      const payload = { fields };

      // API 호출
      const response = await jiraFetch('/api/jira/ignite/issue', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const result = await response.json();

      if (result.success && result.data) {
        const ticketKey = result.data.key;
        setCreatedTicketKey(ticketKey);
        setCreatedTicketSummary(summary);
        toast.success(`티켓이 생성되었습니다! (${ticketKey})`, {
          duration: 5000,
        });

        // 입력 필드 초기화 (다음 티켓 생성을 위해)
        setSummary('');
        setEstimatedTime('');
        setStartDate('');
        setEndDate('');
        setRelatedLink('');
      } else {
        toast.error(result.error || '티켓 생성에 실패했습니다.');
      }
    } catch (error) {
      toast.error(
        `티켓 생성 중 오류가 발생했습니다: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsCreating(false);
    }
  };

  // 에픽이 선택되었는지 확인
  const isEpicSelected = !!selectedEpic;

  // 에픽 summary에 따라 프로젝트 태그 색상 클래스 반환
  const getProjectColorClass = (summary: string): string => {
    if (summary.startsWith('[CPO]')) {
      return 'text-blue-700 font-medium data-[highlighted]:bg-blue-50 data-[state=checked]:bg-blue-100 data-[state=checked]:text-blue-800';
    }
    if (summary.startsWith('[GW]')) {
      return 'text-green-700 font-medium data-[highlighted]:bg-green-50 data-[state=checked]:bg-green-100 data-[state=checked]:text-green-800';
    }
    if (summary.startsWith('[HB]')) {
      return 'text-purple-700 font-medium data-[highlighted]:bg-purple-50 data-[state=checked]:bg-purple-100 data-[state=checked]:text-purple-800';
    }
    return 'text-gray-700';
  };

  // 티켓 링크 복사
  const handleCopyTicketLink = async () => {
    if (!createdTicketKey) return;

    const ticketUrl = `${JIRA_ENDPOINTS.IGNITE}/browse/${createdTicketKey}`;

    try {
      await navigator.clipboard.writeText(ticketUrl);
      toast.success('티켓 링크가 클립보드에 복사되었습니다!');
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  };

  // 티켓 제목 복사
  const handleCopyTicketTitle = async () => {
    if (!createdTicketSummary.trim()) return;

    try {
      await navigator.clipboard.writeText(createdTicketSummary.trim());
      toast.success('티켓 제목이 클립보드에 복사되었습니다!');
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  };

  /**
   * 생성된 티켓 동기화
   * 메인 페이지의 '티켓 지정' 동기화와 동일한 로직 사용
   * 티켓 생성 시 저장된 담당자 정보를 자동으로 사용
   */
  const handleSyncCreatedTicket = async () => {
    // 유효성 검증
    if (!createdTicketKey) {
      toast.error('동기화할 티켓이 없습니다.');
      return;
    }

    if (!currentUser) {
      toast.error('사용자가 선택되지 않았습니다.');
      return;
    }

    // 티켓 키에서 번호 추출 (예: FEHG-1234 → 1234)
    const ticketIdMatch = createdTicketKey.match(new RegExp(`${sourceProject}-(\\d+)`));
    if (!ticketIdMatch) {
      toast.error('올바르지 않은 티켓 키 형식입니다.');
      return;
    }

    const ticketId = ticketIdMatch[1];

    setIsSyncingTicket(true);

    try {
      toast.info(`${createdTicketKey} 티켓 동기화를 시작합니다...`);

      // SyncOrchestrator 인스턴스 생성 (로그는 무시, 결과만 사용)
      const orchestrator = new SyncOrchestrator();

      // 티켓 지정 모드로 동기화 실행
      const summary = await orchestrator.execute({
        assigneeAccountId: currentUser.igniteAccountId,
        ticketId,
        chunkSize: 15,
      });

      // 결과 처리
      if (summary.totalFailed === 0 && summary.totalSuccess > 0) {
        const resultMessage =
          summary.totalCreated > 0
            ? `동기화 완료! ${summary.totalCreated}개 티켓 신규 생성`
            : `동기화 완료! ${summary.totalUpdated}개 티켓 업데이트`;

        toast.success(resultMessage, { duration: 5000 });
      } else if (summary.totalSuccess > 0) {
        toast.warning(
          `동기화 완료 (성공: ${summary.totalSuccess}, 실패: ${summary.totalFailed})`,
          { duration: 5000 }
        );
      } else {
        toast.error(
          '동기화 대상 프로젝트가 없습니다. 티켓이 다른 프로젝트와 연결되어 있는지 확인하세요.',
          { duration: 5000 }
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(`동기화 실패: ${errorMessage}`, { duration: 5000 });
    } finally {
      setIsSyncingTicket(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-2 h-4 w-4" />
                돌아가기
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">{sourceProject} 티켓 생성</h1>
              <p className="text-sm text-muted-foreground">
                새로운 {sourceProject} 티켓을 생성합니다
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {/* @deprecated 에픽 생성 - 관리자 페이지로 이전 예정 */}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>티켓 정보</CardTitle>
            <CardDescription>
              상위 에픽을 선택하고 티켓 정보를 입력하세요
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* 에픽 선택 */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1">
                상위 에픽
                <span className="text-red-500">*</span>
              </label>
              <Select
                value={selectedEpic}
                onValueChange={setSelectedEpic}
                disabled={isLoadingEpics}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      isLoadingEpics
                        ? '에픽 목록 로딩 중...'
                        : '상위 에픽을 선택하세요'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {fehgEpics
                    .slice()
                    .sort((a, b) => {
                      // 1. 제목 기준 오름차순
                      const summaryCompare = a.fields.summary.localeCompare(
                        b.fields.summary
                      );
                      if (summaryCompare !== 0) return summaryCompare;
                      // 2. 티켓 번호 기준 오름차순
                      return a.key.localeCompare(b.key);
                    })
                    .map((epic) => (
                      <SelectItem
                        key={epic.id}
                        value={epic.key}
                        className={getProjectColorClass(epic.fields.summary)}
                      >
                        {epic.key} - {epic.fields.summary}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {fehgEpics.length === 0 && !isLoadingEpics && (
                <p className="text-xs text-muted-foreground">
                  진행 중인 에픽이 없습니다.
                </p>
              )}
            </div>

            {/* 에픽 선택 후 나타나는 입력 필드들 */}
            {isEpicSelected && (
              <div className="space-y-6 pt-6 mt-4 border-t">
                {/* Summary */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-1">
                    티켓 제목 (Summary)
                    <span className="text-red-500">*</span>
                  </label>
                  <Input
                    placeholder="티켓 제목을 입력하세요"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    maxLength={100}
                  />
                  <p className="text-xs text-muted-foreground">
                    {summary.length}/100자
                  </p>
                </div>

                {/* 담당자 (읽기 전용) */}
                <div className="space-y-2">
                  <label className="text-sm font-medium flex items-center gap-1">
                    담당자
                  </label>
                  <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    {currentUser ? (
                      <>
                        <span className="font-medium">{currentUser.name}</span>
                        {currentUser.teamName && (
                          <span className="text-xs text-muted-foreground rounded-full bg-secondary px-2 py-0.5">
                            {currentUser.teamName}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">사용자를 먼저 선택해주세요</span>
                    )}
                  </div>
                </div>

                {/* 관련 업무 링크 */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">관련 업무 링크</label>
                  <Input
                    type="url"
                    placeholder="슬랙 또는 두레이 링크 (선택사항)"
                    value={relatedLink}
                    onChange={(e) => setRelatedLink(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    업무 요청이 온 슬랙/두레이 링크를 입력하면 티켓 설명에
                    자동으로 추가됩니다
                  </p>
                </div>

                {/* 최초추정치 */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">최초추정치</label>
                  <Input
                    placeholder="예: 3d, 1m, 2w, 1.5h (선택사항)"
                    value={estimatedTime}
                    onChange={handleEstimatedTimeInput}
                    className={
                      estimatedTimeError
                        ? 'border-red-500 focus-visible:ring-red-500'
                        : ''
                    }
                  />
                  {estimatedTimeError ? (
                    <p className="text-xs text-red-500">{estimatedTimeError}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      형식: 숫자 + 단위 (d=일, m=분, w=주, h=시간)
                    </p>
                  )}
                </div>

                {/* 날짜 선택 */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">시작일</label>
                    <Input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">종료일</label>
                    <Input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                    />
                  </div>
                </div>

                {/* 생성 버튼 */}
                <div className="pt-4 border-t">
                  <Button
                    onClick={handleCreateTicket}
                    disabled={isCreating}
                    className="w-full"
                    size="lg"
                  >
                    <Plus
                      className={`mr-2 h-4 w-4 ${isCreating ? 'animate-spin' : ''}`}
                    />
                    {isCreating ? '티켓 생성 중...' : '티켓 생성'}
                  </Button>
                </div>

                {/* 생성 결과 */}
                {createdTicketKey && (
                  <div className="pt-4 border-t">
                    <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                      <p className="text-sm font-semibold text-green-900">
                        ✓ 티켓 생성 완료!
                      </p>
                      <div className="flex flex-col gap-2">
                        <a
                          href={`${JIRA_ENDPOINTS.IGNITE}/browse/${createdTicketKey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium"
                        >
                          {createdTicketKey} 티켓으로 이동
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        {createdTicketSummary.trim() && (
                          <p className="text-sm text-green-900/90 break-words">
                            <span className="font-medium">제목:</span>{' '}
                            {createdTicketSummary}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Button
                              onClick={handleCopyTicketLink}
                              variant="outline"
                              size="sm"
                              className="w-full sm:w-fit"
                              disabled={isSyncingTicket}
                            >
                              <Copy className="mr-2 h-3 w-3" />
                              티켓 링크 복사하기
                            </Button>
                            <Button
                              onClick={handleCopyTicketTitle}
                              variant="outline"
                              size="sm"
                              className="w-full sm:w-fit"
                              disabled={isSyncingTicket}
                            >
                              <Copy className="mr-2 h-3 w-3" />
                              티켓 제목 복사하기
                            </Button>
                          </div>
                          <Button
                            onClick={handleSyncCreatedTicket}
                            variant="default"
                            size="sm"
                            className="w-full sm:w-fit sm:ml-auto"
                            disabled={isSyncingTicket}
                          >
                            <RefreshCw
                              className={`mr-2 h-3 w-3 ${isSyncingTicket ? 'animate-spin' : ''}`}
                            />
                            {isSyncingTicket
                              ? '동기화 중...'
                              : '티켓 동기화하기'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
