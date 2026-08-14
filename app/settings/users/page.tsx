'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
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
import { Plus, Pencil, Trash2, Check, Loader2, Search, CircleCheck, CircleX, RotateCcw, AlertTriangle, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/lib/db';
import { useCurrentUser } from '@/contexts/user-context';

interface Team {
  id: string;
  name: string;
}

interface User {
  id: string;
  name: string;
  igniteAccountId: string;
  igniteJiraEmail: string;
  igniteJiraApiToken: string;
  hmgAccountId: string;
  hmgJiraEmail: string;
  hmgJiraApiToken: string;
  hmgUserId: string;
  teamId: string;
}

interface JiraVerifyResult {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

interface FormState {
  name: string;
  teamId: string;
  igniteJiraEmail: string;
  igniteJiraApiToken: string;
  hmgJiraEmail: string;
  hmgJiraApiToken: string;
  hmgUserId: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  teamId: '',
  igniteJiraEmail: '',
  igniteJiraApiToken: '',
  hmgJiraEmail: '',
  hmgJiraApiToken: '',
  hmgUserId: '',
};

export default function UsersPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { currentUser, setCurrentUser } = useCurrentUser();
  const setupUserId = searchParams.get('setup');

  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [setupTriggered, setSetupTriggered] = useState(false);

  // 검증 상태
  const [igniteVerifying, setIgniteVerifying] = useState(false);
  const [igniteVerified, setIgniteVerified] = useState<JiraVerifyResult | null>(null);
  const [igniteVerifyError, setIgniteVerifyError] = useState<string | null>(null);

  const [hmgVerifying, setHmgVerifying] = useState(false);
  const [hmgVerified, setHmgVerified] = useState<JiraVerifyResult | null>(null);
  const [hmgVerifyError, setHmgVerifyError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const [teamsRes, usersRes] = await Promise.all([
      db.from('teams').select('id, name').order('name'),
      db.from('users').select('*').order('name'),
    ]);

    if (teamsRes.data) setTeams(teamsRes.data);
    if (usersRes.data) {
      setUsers(
        usersRes.data.map((u) => ({
          id: u.id,
          name: u.name,
          igniteAccountId: u.ignite_account_id || '',
          igniteJiraEmail: u.ignite_jira_email || '',
          igniteJiraApiToken: u.ignite_jira_api_token || '',
          hmgAccountId: u.hmg_account_id || '',
          hmgJiraEmail: u.hmg_jira_email || '',
          hmgJiraApiToken: u.hmg_jira_api_token || '',
          hmgUserId: u.hmg_user_id || '',
          teamId: u.team_id || '',
        }))
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // setup 모드: 사용자 목록 로드 후 해당 사용자의 편집 모드 자동 진입
  useEffect(() => {
    if (setupUserId && users.length > 0 && !setupTriggered) {
      const targetUser = users.find((u) => u.id === setupUserId);
      if (targetUser) {
        handleEdit(targetUser);
        setSetupTriggered(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupUserId, users, setupTriggered]);

  const updateForm = (field: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const resetAllVerify = () => {
    setIgniteVerified(null);
    setIgniteVerifyError(null);
    setHmgVerified(null);
    setHmgVerifyError(null);
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setIsAdding(false);
    setEditingId(null);
    resetAllVerify();
  };

  // Ignite Jira 검증
  const handleIgniteVerify = async () => {
    const email = form.igniteJiraEmail.trim();
    const token = form.igniteJiraApiToken.trim();
    if (!email || !token) {
      toast.error('Ignite Jira Email과 API Token을 모두 입력해주세요.');
      return;
    }

    setIgniteVerifying(true);
    setIgniteVerified(null);
    setIgniteVerifyError(null);

    try {
      const res = await fetch('/api/jira/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: 'ignite', email, apiToken: token }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        setIgniteVerified(result.data);
        toast.success(`Ignite 인증 확인: ${result.data.displayName}`);
      } else {
        setIgniteVerifyError(result.error || '검증에 실패했습니다.');
        toast.error(`Ignite 검증 실패: ${result.error}`);
      }
    } catch {
      setIgniteVerifyError('API 호출 중 오류가 발생했습니다.');
      toast.error('Ignite Jira 검증에 실패했습니다.');
    } finally {
      setIgniteVerifying(false);
    }
  };

  const resetIgniteVerify = () => {
    setIgniteVerified(null);
    setIgniteVerifyError(null);
    setForm((prev) => ({ ...prev, igniteJiraEmail: '', igniteJiraApiToken: '' }));
  };

  // HMG Jira 검증
  const handleHmgVerify = async () => {
    const email = form.hmgJiraEmail.trim();
    const token = form.hmgJiraApiToken.trim();
    if (!email || !token) {
      toast.error('HMG Jira Email과 API Token을 모두 입력해주세요.');
      return;
    }

    setHmgVerifying(true);
    setHmgVerified(null);
    setHmgVerifyError(null);

    try {
      const res = await fetch('/api/jira/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: 'hmg', email, apiToken: token }),
      });
      const result = await res.json();

      if (result.success && result.data) {
        setHmgVerified(result.data);
        toast.success(`HMG 인증 확인: ${result.data.displayName}`);
      } else {
        setHmgVerifyError(result.error || '검증에 실패했습니다.');
        toast.error(`HMG 검증 실패: ${result.error}`);
      }
    } catch {
      setHmgVerifyError('API 호출 중 오류가 발생했습니다.');
      toast.error('HMG Jira 검증에 실패했습니다.');
    } finally {
      setHmgVerifying(false);
    }
  };

  const resetHmgVerify = () => {
    setHmgVerified(null);
    setHmgVerifyError(null);
    setForm((prev) => ({ ...prev, hmgJiraEmail: '', hmgJiraApiToken: '', hmgUserId: '' }));
  };

  const bothVerified = !!igniteVerified && !!hmgVerified;

  const toDbRow = () => ({
    name: form.name.trim(),
    team_id: form.teamId || null,
    ignite_account_id: igniteVerified?.accountId || '',
    ignite_jira_email: form.igniteJiraEmail.trim(),
    ignite_jira_api_token: form.igniteJiraApiToken.trim(),
    hmg_account_id: hmgVerified?.accountId || '',
    hmg_jira_email: form.hmgJiraEmail.trim(),
    hmg_jira_api_token: form.hmgJiraApiToken.trim(),
    hmg_user_id: form.hmgUserId.trim(),
  });

  const handleAdd = async () => {
    if (!form.name.trim()) {
      toast.error('이름을 입력해주세요.');
      return;
    }
    if (!form.teamId) {
      toast.error('팀을 선택해주세요.');
      return;
    }
    if (!bothVerified) {
      toast.error('Ignite Jira와 HMG Jira 인증을 모두 검증해주세요.');
      return;
    }

    setSaving(true);
    const { error } = await db.from('users').insert(toDbRow());
    setSaving(false);

    if (error) {
      toast.error(`저장 실패: ${error.message}`);
      return;
    }

    const name = form.name.trim();
    resetForm();
    toast.success(`${name} 사용자가 추가되었습니다.`);
    fetchData();
  };

  const handleEdit = (user: User) => {
    setEditingId(user.id);
    setForm({
      name: user.name,
      teamId: user.teamId,
      igniteJiraEmail: user.igniteJiraEmail,
      igniteJiraApiToken: user.igniteJiraApiToken,
      hmgJiraEmail: user.hmgJiraEmail,
      hmgJiraApiToken: user.hmgJiraApiToken,
      hmgUserId: user.hmgUserId,
    });
    // 기존 사용자는 이미 검증된 것으로 간주
    if (user.igniteJiraEmail && user.igniteJiraApiToken) {
      setIgniteVerified({
        accountId: user.igniteAccountId,
        displayName: user.name,
      });
    }
    if (user.hmgJiraEmail && user.hmgJiraApiToken) {
      setHmgVerified({
        accountId: user.hmgAccountId,
        displayName: user.name,
      });
    }
    setIgniteVerifyError(null);
    setHmgVerifyError(null);
    setIsAdding(false);
  };

  const handleEditSave = async () => {
    if (!form.name.trim() || !form.teamId) {
      toast.error('이름과 팀을 입력해주세요.');
      return;
    }
    if (!bothVerified) {
      toast.error('Ignite Jira와 HMG Jira 인증을 모두 검증해주세요.');
      return;
    }

    setSaving(true);
    const { error } = await db
      .from('users')
      .update(toDbRow())
      .eq('id', editingId);
    setSaving(false);

    if (error) {
      toast.error(`저장 실패: ${error.message}`);
      return;
    }

    // setup 모드에서 저장 시 currentUser 갱신 후 홈으로 이동
    if (setupUserId && editingId === setupUserId && currentUser?.id === setupUserId) {
      setCurrentUser({
        ...currentUser,
        igniteAccountId: igniteVerified?.accountId || '',
        hmgAccountId: hmgVerified?.accountId || '',
        hmgUserId: form.hmgUserId.trim(),
        hasIgniteCredentials: Boolean(
          form.igniteJiraEmail.trim() && form.igniteJiraApiToken.trim()
        ),
        hasHmgCredentials: Boolean(
          form.hmgJiraEmail.trim() && form.hmgJiraApiToken.trim()
        ),
      });
      resetForm();
      toast.success('Jira 인증 설정이 완료되었습니다.');
      router.push('/');
      return;
    }

    resetForm();
    toast.success('사용자 정보가 수정되었습니다.');
    fetchData();
  };

  const handleDelete = async (user: User) => {
    const { error } = await db.from('users').delete().eq('id', user.id);
    if (error) {
      toast.error(`삭제 실패: ${error.message}`);
      return;
    }
    toast.success(`${user.name} 사용자가 삭제되었습니다.`);
    fetchData();
  };

  const getTeamName = (teamId: string) => {
    return teams.find((t) => t.id === teamId)?.name || '-';
  };

  // Jira 검증 섹션 컴포넌트
  const jiraSection = (
    instance: 'ignite' | 'hmg',
    label: string,
    verifying: boolean,
    verified: JiraVerifyResult | null,
    verifyError: string | null,
    onVerify: () => void,
    onReset: () => void,
    emailField: keyof FormState,
    tokenField: keyof FormState,
  ) => (
    <div className="space-y-2 pt-1">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {label}
      </p>

      {verified ? (
        /* 검증 완료: 읽기 전용 요약 */
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
            <CircleCheck className="h-4 w-4 text-emerald-500 shrink-0" />
            <span className="text-sm font-medium">{verified.displayName}</span>
            <span className="text-xs text-muted-foreground font-mono">
              {verified.accountId.length > 20
                ? `${verified.accountId.slice(0, 20)}...`
                : verified.accountId}
            </span>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onReset}>
            <RotateCcw className="mr-1 h-3 w-3" />
            변경
          </Button>
        </div>
      ) : (
        /* 검증 전: 입력 필드 */
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">
                Email <span className="text-destructive">*</span>
              </label>
              <Input
                placeholder={instance === 'ignite' ? 'example@ignite.co.kr' : 'zs12345@hyundai-partners.com'}
                value={form[emailField]}
                onChange={(e) => updateForm(emailField, e.target.value)}
                disabled={verifying}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                API Token <span className="text-destructive">*</span>
              </label>
              <Input
                type="password"
                placeholder="ATATT3x..."
                value={form[tokenField]}
                onChange={(e) => updateForm(tokenField, e.target.value)}
                disabled={verifying}
              />
            </div>
          </div>
          <a
            href="https://ignitecorp.atlassian.net/wiki/spaces/IF/pages/2262237262/FE1"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            토큰 설정 가이드 바로가기
          </a>
          {/* HMG에만 사번 필드 */}
          {instance === 'hmg' && (
            <div className="space-y-1">
              <label className="text-xs font-medium">사번</label>
              <Input
                placeholder="ZS00000"
                value={form.hmgUserId}
                onChange={(e) => updateForm('hmgUserId', e.target.value)}
                disabled={verifying}
              />
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onVerify}
            disabled={verifying || !form[emailField].trim() || !form[tokenField].trim()}
            className="w-full"
          >
            {verifying ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="mr-1 h-3.5 w-3.5" />
            )}
            {label} 인증 검증
          </Button>
          {verifyError && (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <CircleX className="h-3.5 w-3.5 shrink-0" />
              <span>{verifyError}</span>
            </div>
          )}
        </>
      )}
    </div>
  );

  const formUI = (
    <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
      {/* 기본 정보 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium">
            이름 <span className="text-destructive">*</span>
          </label>
          <Input
            placeholder="홍길동"
            value={form.name}
            onChange={(e) => updateForm('name', e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">
            팀 <span className="text-destructive">*</span>
          </label>
          <Select
            value={form.teamId}
            onValueChange={(v) => updateForm('teamId', v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="팀 선택" />
            </SelectTrigger>
            <SelectContent>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Ignite Jira 검증 */}
      {jiraSection(
        'ignite',
        'Ignite Jira',
        igniteVerifying,
        igniteVerified,
        igniteVerifyError,
        handleIgniteVerify,
        resetIgniteVerify,
        'igniteJiraEmail',
        'igniteJiraApiToken',
      )}

      {/* HMG Jira 검증 */}
      {jiraSection(
        'hmg',
        'HMG Jira',
        hmgVerifying,
        hmgVerified,
        hmgVerifyError,
        handleHmgVerify,
        resetHmgVerify,
        'hmgJiraEmail',
        'hmgJiraApiToken',
      )}

      {/* 저장 버튼 */}
      <div className="flex items-center justify-between border-t pt-3">
        <div className="text-xs text-muted-foreground">
          {bothVerified ? (
            <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <CircleCheck className="h-3.5 w-3.5" />
              양쪽 Jira 인증이 모두 확인되었습니다.
            </span>
          ) : (
            '양쪽 Jira 인증 검증을 완료해야 저장할 수 있습니다.'
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={resetForm} disabled={saving}>
            취소
          </Button>
          <Button
            size="sm"
            onClick={editingId ? handleEditSave : handleAdd}
            disabled={saving || !bothVerified}
          >
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-1 h-4 w-4" />
            )}
            {editingId ? '저장' : '추가'}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="max-w-3xl space-y-4">
      {/* Setup 모드 안내 배너 */}
      {setupUserId && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-500/30">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-medium">Jira 인증 설정이 필요합니다</p>
            <p className="text-amber-800/80 dark:text-amber-300/70 mt-0.5">
              Ignite Jira와 HMG Jira 인증을 모두 완료해야 동기화 기능을 사용할 수 있습니다.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>사용자 관리</CardTitle>
            <CardDescription>
              Jira 동기화 대상 사용자를 등록하고 관리합니다.
            </CardDescription>
          </div>
          {!isAdding && !editingId && (
            <Button
              onClick={() => {
                setIsAdding(true);
                setForm(EMPTY_FORM);
                resetAllVerify();
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              사용자 추가
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {(isAdding || editingId) && formUI}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">이름</th>
                    <th className="text-left px-4 py-2 font-medium">팀</th>
                    <th className="text-left px-4 py-2 font-medium">Ignite ID</th>
                    <th className="text-left px-4 py-2 font-medium">HMG 사번</th>
                    <th className="w-20 px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-8 text-center text-muted-foreground"
                      >
                        등록된 사용자가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => (
                      <tr
                        key={user.id}
                        className={
                          editingId === user.id ? 'bg-muted/30' : undefined
                        }
                      >
                        <td className="px-4 py-2 font-medium">{user.name}</td>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">
                            {getTeamName(user.teamId)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                          {user.igniteAccountId
                            ? `${user.igniteAccountId.slice(0, 12)}...`
                            : '-'}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {user.hmgUserId || '-'}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex gap-1 justify-end">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleEdit(user)}
                              disabled={!!editingId || isAdding}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleDelete(user)}
                              disabled={!!editingId || isAdding}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
