'use client';

import { useState } from 'react';
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
import { toast } from 'sonner';
import { jira } from '@/lib/services/jira';

export default function TestUpdatePage() {
  const [issueKey] = useState('FEHG-2111');
  const [isUpdating, setIsUpdating] = useState(false);

  // 업데이트할 필드들
  const [summary, setSummary] = useState('');
  const [duedate, setDuedate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [assignee, setAssignee] = useState('');
  const [timetracking, setTimetracking] = useState(''); // 3h, 2d, 30m 형식
  const [sprint, setSprint] = useState('');
  const [autowayNumber, setAutowayNumber] = useState(''); // AUTOWAY 티켓 번호만

  const handleUpdate = async () => {
    setIsUpdating(true);
    try {
      const payload: Record<string, unknown> = {};

      if (summary) payload.summary = summary;
      if (duedate) payload.duedate = duedate;
      if (startDate) payload.customfield_10015 = startDate;
      if (assignee) payload.assignee = { accountId: assignee };

      // timetracking: 간단한 형식(3h, 2d, 30m) → JSON 변환
      if (timetracking) {
        const pattern = /^(\d+\.?\d*)(h|d|m)$/i;
        if (!pattern.test(timetracking.trim())) {
          toast.error(
            'timetracking 형식이 올바르지 않습니다 (예: 3h, 2d, 30m)'
          );
          setIsUpdating(false);
          return;
        }
        payload.timetracking = { originalEstimate: timetracking.trim() };
      }

      if (sprint) payload.customfield_10020 = parseInt(sprint);

      // AUTOWAY 번호 → URL 변환
      if (autowayNumber) {
        payload.customfield_10438 = `https://hmg.atlassian.net/browse/AUTOWAY-${autowayNumber}`;
      }

      // API Routes를 통해 업데이트
      const response = await jiraFetch(`/api/jira/ignite/issue/${issueKey}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: payload }),
      });

      const result = await response.json();

      if (result.success) {
        toast.success(`${issueKey} 업데이트 성공!`);
      } else {
        toast.error(result.error || '업데이트 실패');
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '업데이트 중 오류 발생'
      );
    } finally {
      setIsUpdating(false);
    }
  };

  const handleLoadCurrent = async () => {
    try {
      const result = await jira.ignite.getIssue(issueKey);
      if (result.success && result.data) {
        const issue = result.data;
        setSummary(issue.fields.summary || '');
        setDuedate(issue.fields.duedate || '');
        const customFields = issue.fields;
        setStartDate((customFields.customfield_10015 as string) || '');
        setAssignee(issue.fields.assignee?.accountId || '');

        // customfield_10438에서 AUTOWAY 번호 추출
        const hmgUrl = (customFields.customfield_10438 as string) || '';
        if (hmgUrl) {
          const match = hmgUrl.match(/AUTOWAY-(\d+)/);
          setAutowayNumber(match ? match[1] : '');
        }

        // timetracking: originalEstimate 추출
        if (issue.fields.timetracking?.originalEstimate) {
          setTimetracking(issue.fields.timetracking.originalEstimate);
        }

        toast.success('현재 티켓 정보를 불러왔습니다');
      }
    } catch {
      toast.error('티켓 정보 조회 실패');
    }
  };

  return (
    <main className="min-h-screen bg-background p-8">
      <div className="container mx-auto max-w-4xl">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">필드 업데이트 테스트</h1>
          <p className="text-muted-foreground">대상 티켓: {issueKey}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>업데이트할 필드</CardTitle>
            <CardDescription>
              비어있는 필드는 업데이트하지 않습니다
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              onClick={handleLoadCurrent}
              variant="outline"
              className="w-full mb-4"
            >
              현재 티켓 정보 불러오기
            </Button>

            <div className="space-y-2">
              <label className="text-sm font-medium">summary (제목)</label>
              <Input
                placeholder="제목"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                duedate (종료일) - YYYY-MM-DD
              </label>
              <Input
                type="date"
                value={duedate}
                onChange={(e) => setDuedate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                customfield_10015 (시작일) - YYYY-MM-DD
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                assignee (담당자 accountId)
              </label>
              <Input
                placeholder="예: 5b10a2844c20165700ede21g"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                timetracking (원본 추정치)
              </label>
              <Input
                placeholder="예: 3h, 2d, 30m"
                value={timetracking}
                onChange={(e) => setTimetracking(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                형식: 숫자 + 단위 (h=시간, d=일, m=분)
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                customfield_10020 (스프린트 ID)
              </label>
              <Input
                placeholder="예: 1234"
                value={sprint}
                onChange={(e) => setSprint(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                customfield_10438 (AUTOWAY 티켓 번호)
              </label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="예: 123 → AUTOWAY-123"
                value={autowayNumber}
                onChange={(e) =>
                  setAutowayNumber(e.target.value.replace(/[^0-9]/g, ''))
                }
              />
              <p className="text-xs text-muted-foreground">
                숫자만 입력 • 자동으로 https://hmg.atlassian.net/browse/AUTOWAY-
                {autowayNumber || 'XXX'} 형태로 저장
              </p>
            </div>

            <Button
              onClick={handleUpdate}
              disabled={isUpdating}
              className="w-full mt-6"
              size="lg"
            >
              {isUpdating ? '업데이트 중...' : `${issueKey} 업데이트`}
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
