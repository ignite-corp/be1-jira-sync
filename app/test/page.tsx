'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { jira } from '@/lib/services/jira';
import { JiraApiResponse } from '@/lib/types/jira';

export default function TestPage() {
  const [igniteResult, setIgniteResult] =
    useState<JiraApiResponse<unknown> | null>(null);
  const [hmgResult, setHmgResult] = useState<JiraApiResponse<unknown> | null>(
    null
  );
  const [loading, setLoading] = useState<{
    ignite: boolean;
    hmg: boolean;
  }>({
    ignite: false,
    hmg: false,
  });

  const testIgnite = async () => {
    setLoading((prev) => ({ ...prev, ignite: true }));
    setIgniteResult(null);

    try {
      const result = await jira.ignite.getServerInfo();
      setIgniteResult(result);
    } catch (error) {
      setIgniteResult({
        success: false,
        error: error instanceof Error ? error.message : '오류 발생',
      });
    } finally {
      setLoading((prev) => ({ ...prev, ignite: false }));
    }
  };

  const testHmg = async () => {
    setLoading((prev) => ({ ...prev, hmg: true }));
    setHmgResult(null);

    try {
      const result = await jira.hmg.getServerInfo();
      setHmgResult(result);
    } catch (error) {
      setHmgResult({
        success: false,
        error: error instanceof Error ? error.message : '오류 발생',
      });
    } finally {
      setLoading((prev) => ({ ...prev, hmg: false }));
    }
  };

  const testIgniteProjects = async () => {
    setLoading((prev) => ({ ...prev, ignite: true }));
    setIgniteResult(null);

    try {
      const result = await jira.ignite.getProjects();
      setIgniteResult(result);
    } catch (error) {
      setIgniteResult({
        success: false,
        error: error instanceof Error ? error.message : '오류 발생',
      });
    } finally {
      setLoading((prev) => ({ ...prev, ignite: false }));
    }
  };

  const testHmgProjects = async () => {
    setLoading((prev) => ({ ...prev, hmg: true }));
    setHmgResult(null);

    try {
      const result = await jira.hmg.getProjects();
      setHmgResult(result);
    } catch (error) {
      setHmgResult({
        success: false,
        error: error instanceof Error ? error.message : '오류 발생',
      });
    } finally {
      setLoading((prev) => ({ ...prev, hmg: false }));
    }
  };

  return (
    <main className="min-h-screen bg-background p-8">
      <div className="container mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold mb-8">Jira API 연결 테스트</h1>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Ignite Jira */}
          <Card>
            <CardHeader>
              <CardTitle>Ignite Jira</CardTitle>
              <CardDescription>ignitecorp.atlassian.net</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  onClick={testIgnite}
                  disabled={loading.ignite}
                  variant="default"
                >
                  {loading.ignite ? '테스트 중...' : '서버 정보 조회'}
                </Button>
                <Button
                  onClick={testIgniteProjects}
                  disabled={loading.ignite}
                  variant="secondary"
                >
                  {loading.ignite ? '테스트 중...' : '프로젝트 목록'}
                </Button>
              </div>

              {igniteResult && (
                <div className="mt-4 p-4 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-block w-3 h-3 rounded-full ${
                        igniteResult.success ? 'bg-green-500' : 'bg-red-500'
                      }`}
                    />
                    <span className="font-semibold">
                      {igniteResult.success ? '연결 성공' : '연결 실패'}
                    </span>
                  </div>
                  <pre className="text-xs overflow-auto max-h-96">
                    {JSON.stringify(igniteResult, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* HMG Jira */}
          <Card>
            <CardHeader>
              <CardTitle>HMG Jira</CardTitle>
              <CardDescription>hmg.atlassian.net (VPN 필요)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button
                  onClick={testHmg}
                  disabled={loading.hmg}
                  variant="default"
                >
                  {loading.hmg ? '테스트 중...' : '서버 정보 조회'}
                </Button>
                <Button
                  onClick={testHmgProjects}
                  disabled={loading.hmg}
                  variant="secondary"
                >
                  {loading.hmg ? '테스트 중...' : '프로젝트 목록'}
                </Button>
              </div>

              {hmgResult && (
                <div className="mt-4 p-4 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-block w-3 h-3 rounded-full ${
                        hmgResult.success ? 'bg-green-500' : 'bg-red-500'
                      }`}
                    />
                    <span className="font-semibold">
                      {hmgResult.success ? '연결 성공' : '연결 실패'}
                    </span>
                  </div>
                  <pre className="text-xs overflow-auto max-h-96">
                    {JSON.stringify(hmgResult, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="mt-8 p-4 bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <h3 className="font-semibold mb-2 text-yellow-900 dark:text-yellow-200">
            ⚠️ 주의사항
          </h3>
          <ul className="text-sm space-y-1 text-yellow-800 dark:text-yellow-300">
            <li>• HMG Jira는 VPN 연결 후에만 테스트 가능합니다</li>
            <li>• .env.local 파일에 올바른 인증 정보가 설정되어야 합니다</li>
            <li>• 개발 서버를 재시작해야 환경 변수가 적용됩니다</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
