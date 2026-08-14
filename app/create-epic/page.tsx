'use client';

import { useState } from 'react';
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
  ArrowLeft,
  Plus,
  ExternalLink,
  Copy,
  Network,
} from 'lucide-react';
import { toast } from 'sonner';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { useCurrentUser } from '@/contexts/user-context';

export default function CreateEpicPage() {
  const { currentUser } = useCurrentUser();
  const sourceProject = currentUser?.sourceProject || 'FEHG';
  // 입력 필드
  const [isAutowayEpic, setIsAutowayEpic] = useState<boolean>(true);
  const [summary, setSummary] = useState<string>('');

  // 생성 상태
  const [isCreating, setIsCreating] = useState(false);
  const [createdFehgEpicKey, setCreatedFehgEpicKey] = useState<string>('');
  const [createdAutowayEpicKey, setCreatedAutowayEpicKey] =
    useState<string>('');

  /**
   * 에픽 생성 핸들러
   */
  const handleCreateEpic = async () => {
    // 유효성 검증
    if (!summary.trim()) {
      toast.error('에픽 제목을 입력해주세요.');
      return;
    }

    setIsCreating(true);
    setCreatedFehgEpicKey('');
    setCreatedAutowayEpicKey('');

    try {
      toast.info(`"${summary}" 에픽 생성을 시작합니다...`);

      // 1. 소스 프로젝트 에픽 생성
      const fehgPayload = {
        fields: {
          project: { key: sourceProject },
          summary,
          issuetype: { id: '10365' }, // 에픽 타입 ID
        },
      };

      const fehgResponse = await jiraFetch('/api/jira/ignite/issue', {
        method: 'POST',
        body: JSON.stringify(fehgPayload),
      });

      const fehgResult = await fehgResponse.json();

      if (!fehgResult.success || !fehgResult.data) {
        toast.error(fehgResult.error || `${sourceProject} 에픽 생성에 실패했습니다.`);
        return;
      }

      const fehgEpicKey = fehgResult.data.key;
      setCreatedFehgEpicKey(fehgEpicKey);
      toast.success(`${sourceProject} 에픽이 생성되었습니다! (${fehgEpicKey})`, {
        duration: 3000,
      });

      // 2. AUTOWAY 에픽 생성 (선택한 경우만)
      if (isAutowayEpic) {
        toast.info('AUTOWAY 에픽을 생성하는 중...');

        const autowayPayload = {
          fields: {
            project: { key: 'AUTOWAY' },
            summary: `[${sourceProject}] ${summary}`,
            // AUTOWAY 프로젝트 이슈 타입은 로캘/설정에 따라 달라질 수 있으나,
            // 프로젝트 메타데이터상 "에픽"이 존재하므로 에픽 생성은 "에픽"으로 고정합니다.
            issuetype: { name: '에픽' },
            description: {
              type: 'doc',
              version: 1,
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: `[자동 생성] ${sourceProject} 에픽 연동`,
                    },
                  ],
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: `원본 ${sourceProject} 에픽: `,
                      marks: [{ type: 'strong' }],
                    },
                    {
                      type: 'text',
                      text: `${JIRA_ENDPOINTS.IGNITE}/browse/${fehgEpicKey}`,
                      marks: [
                        {
                          type: 'link',
                          attrs: {
                            href: `${JIRA_ENDPOINTS.IGNITE}/browse/${fehgEpicKey}`,
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  type: 'rule',
                },
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: `이 에픽은 ${fehgEpicKey}와 연동됩니다.`,
                      marks: [{ type: 'em' }],
                    },
                  ],
                },
              ],
            },
          },
        };

        const autowayResponse = await jiraFetch('/api/jira/hmg/issue', {
          method: 'POST',
          body: JSON.stringify(autowayPayload),
        });

        const autowayResult = await autowayResponse.json();

        if (!autowayResult.success || !autowayResult.data) {
          toast.error(
            autowayResult.error || 'AUTOWAY 에픽 생성에 실패했습니다.'
          );
          return;
        }

        const autowayEpicKey = autowayResult.data.key;
        setCreatedAutowayEpicKey(autowayEpicKey);
        toast.success(`AUTOWAY 에픽이 생성되었습니다! (${autowayEpicKey})`, {
          duration: 3000,
        });

        // 3. 소스 에픽에 AUTOWAY 링크 저장
        toast.info(`${sourceProject} 에픽과 AUTOWAY 에픽을 연결하는 중...`);

        const autowayUrl = `${JIRA_ENDPOINTS.HMG}/browse/${autowayEpicKey}`;
        const linkPayload = {
          fields: {
            customfield_10438: autowayUrl,
          },
        };

        const linkResponse = await jiraFetch(
          `/api/jira/ignite/issue/${fehgEpicKey}`,
          {
            method: 'PUT',
            body: JSON.stringify(linkPayload),
          }
        );

        const linkResult = await linkResponse.json();

        if (linkResult.success) {
          toast.success(`${sourceProject}와 AUTOWAY 에픽이 연결되었습니다!`, {
            duration: 3000,
          });
        } else {
          toast.warning(
            'AUTOWAY 링크 저장에 실패했습니다. 수동으로 연결해주세요.',
            { duration: 5000 }
          );
        }
      }

      // 최종 성공 메시지
      toast.success('에픽 생성이 완료되었습니다!', { duration: 5000 });

      // 입력 필드 초기화 (다음 에픽 생성 준비)
      setSummary('');
    } catch (error) {
      toast.error(
        `에픽 생성 중 오류가 발생했습니다: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsCreating(false);
    }
  };

  /**
   * 소스 에픽 링크 복사
   */
  const handleCopyFehgLink = async () => {
    if (!createdFehgEpicKey) return;
    const url = `${JIRA_ENDPOINTS.IGNITE}/browse/${createdFehgEpicKey}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${sourceProject} 에픽 링크가 복사되었습니다!`);
    } catch {
      toast.error('복사에 실패했습니다.');
    }
  };

  /**
   * AUTOWAY 에픽 링크 복사
   */
  const handleCopyAutowayLink = async () => {
    if (!createdAutowayEpicKey) return;
    const url = `${JIRA_ENDPOINTS.HMG}/browse/${createdAutowayEpicKey}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('AUTOWAY 에픽 링크가 복사되었습니다!');
    } catch {
      toast.error('복사에 실패했습니다.');
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
              <h1 className="text-2xl font-bold">{sourceProject} 에픽 생성</h1>
              <p className="text-sm text-muted-foreground">
                새로운 {sourceProject} 에픽을 생성합니다 (팀장용)
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/flow-chart">
              <Button variant="outline" size="sm">
                <Network className="mr-2 h-4 w-4" />
                Flow Chart
              </Button>
            </Link>
            <Link href="/create-ticket">
              <Button variant="outline" size="sm">
                <Plus className="mr-2 h-4 w-4" />
                티켓 생성
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>에픽 정보</CardTitle>
            <CardDescription>
              에픽 제목과 AUTOWAY 연동 여부를 선택하세요
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* AUTOWAY 에픽 여부 선택 */}
            <div className="space-y-3">
              <label className="text-sm font-medium flex items-center gap-1">
                AUTOWAY 연동 여부
                <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="autoway"
                    checked={isAutowayEpic === true}
                    onChange={() => setIsAutowayEpic(true)}
                    className="w-4 h-4 cursor-pointer"
                  />
                  <span className="text-sm">AUTOWAY 에픽</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="autoway"
                    checked={isAutowayEpic === false}
                    onChange={() => setIsAutowayEpic(false)}
                    className="w-4 h-4 cursor-pointer"
                  />
                  <span className="text-sm">AUTOWAY 에픽 아님</span>
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {isAutowayEpic
                  ? `✅ ${sourceProject}와 AUTOWAY 양쪽에 에픽이 생성되고 자동으로 연결됩니다`
                  : `ℹ️ ${sourceProject}에만 에픽이 생성됩니다`}
              </p>
            </div>

            {/* 에픽 제목 입력 */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1">
                에픽 제목 (Summary)
                <span className="text-red-500">*</span>
              </label>
              <Input
                placeholder="에픽 제목을 입력하세요"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={200}
              />
              <p className="text-xs text-muted-foreground">
                {summary.length}/200자
                {isAutowayEpic && summary && (
                  <span className="ml-2 text-blue-600">
                    → AUTOWAY: [{sourceProject}] {summary}
                  </span>
                )}
              </p>
            </div>

            {/* 생성 버튼 */}
            <div className="pt-4 border-t">
              <Button
                onClick={handleCreateEpic}
                disabled={isCreating || !summary.trim()}
                className="w-full"
                size="lg"
              >
                <Plus
                  className={`mr-2 h-4 w-4 ${isCreating ? 'animate-spin' : ''}`}
                />
                {isCreating ? '에픽 생성 중...' : '에픽 생성'}
              </Button>
            </div>

            {/* 생성 결과 */}
            {createdFehgEpicKey && (
              <div className="pt-4 border-t space-y-4">
                {/* FEHG 에픽 */}
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg space-y-3">
                  <p className="text-sm font-semibold text-green-900">
                    ✓ {sourceProject} 에픽 생성 완료!
                  </p>
                  <div className="flex flex-col gap-2">
                    <a
                      href={`${JIRA_ENDPOINTS.IGNITE}/browse/${createdFehgEpicKey}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium"
                    >
                      {createdFehgEpicKey} 에픽으로 이동
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    <Button
                      onClick={handleCopyFehgLink}
                      variant="outline"
                      size="sm"
                      className="w-fit"
                    >
                      <Copy className="mr-2 h-3 w-3" />
                      {sourceProject} 링크 복사
                    </Button>
                  </div>
                </div>

                {/* AUTOWAY 에픽 */}
                {createdAutowayEpicKey && (
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg space-y-3">
                    <p className="text-sm font-semibold text-blue-900">
                      ✓ AUTOWAY 에픽 생성 완료!
                    </p>
                    <div className="flex flex-col gap-2">
                      <a
                        href={`${JIRA_ENDPOINTS.HMG}/browse/${createdAutowayEpicKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-1 font-medium"
                      >
                        {createdAutowayEpicKey} 에픽으로 이동
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <Button
                        onClick={handleCopyAutowayLink}
                        variant="outline"
                        size="sm"
                        className="w-fit"
                      >
                        <Copy className="mr-2 h-3 w-3" />
                        AUTOWAY 링크 복사
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      ✅ {sourceProject} 에픽의 customfield_10438에 AUTOWAY URL이
                      저장되었습니다
                    </p>
                  </div>
                )}

                {/* Confluence 등록 안내 */}
                {isAutowayEpic && createdAutowayEpicKey && (
                  <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg space-y-2">
                    <p className="text-sm font-semibold text-yellow-900">
                      📌 다음 단계: Confluence 등록
                    </p>
                    <p className="text-xs text-muted-foreground">
                      AUTOWAY 동기화 대상 Epic 목록에 이 에픽을 추가하세요:
                    </p>
                    <a
                      href="https://ignitecorp.atlassian.net/wiki/spaces/IF/pages/2018738177"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline inline-flex items-center gap-1 text-xs"
                    >
                      Confluence 페이지로 이동
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <div className="mt-2 p-2 bg-white rounded border text-xs font-mono">
                      {`{"id": ${createdFehgEpicKey.replace(`${sourceProject}-`, '')}, "summary": "${summary}", "active": true}`}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      ↑ 위 JSON을 복사하여 Confluence 페이지의 배열에 추가하세요
                    </p>
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
