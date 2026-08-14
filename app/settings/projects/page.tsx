'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Plus, Pencil, Trash2, Check, Loader2, Search, CircleCheck, CircleX } from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/lib/db';
import { jiraFetch } from '@/lib/jira-fetch';

interface Team {
  id: string;
  name: string;
}

interface Project {
  id: string;
  name: string;
  jiraProjectKey: string;
  jiraProjectId: string;
  jiraInstance: 'ignite' | 'hmg';
  boardId: number | null;
  teamIds: string[];
}

interface VerifyResult {
  key: string;
  id: string;
  name: string;
  boardId: number | null;
}

interface FormState {
  jiraProjectKey: string;
  jiraInstance: 'ignite' | 'hmg';
  name: string;
  teamIds: string[];
}

const EMPTY_FORM: FormState = {
  jiraProjectKey: '',
  jiraInstance: 'ignite',
  name: '',
  teamIds: [],
};

export default function ProjectsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    const [teamsRes, projectsRes, ptRes] = await Promise.all([
      db.from('teams').select('id, name').order('name'),
      db.from('projects').select('*').order('name'),
      db.from('project_teams').select('project_id, team_id'),
    ]);

    if (teamsRes.data) setTeams(teamsRes.data);

    if (projectsRes.data) {
      const teamMap: Record<string, string[]> = {};
      ptRes.data?.forEach((row) => {
        if (!teamMap[row.project_id]) teamMap[row.project_id] = [];
        teamMap[row.project_id].push(row.team_id);
      });

      setProjects(
        projectsRes.data.map((p) => ({
          id: p.id,
          name: p.name,
          jiraProjectKey: p.name,
          jiraProjectId: p.jira_project_id,
          jiraInstance: p.jira_instance || 'ignite',
          boardId: p.board_id || null,
          teamIds: teamMap[p.id] || [],
        }))
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const updateForm = (field: keyof FormState, value: string | string[]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === 'jiraProjectKey' || field === 'jiraInstance') {
      setVerified(null);
      setVerifyError(null);
    }
  };

  const handleVerify = async () => {
    const projectKey = form.jiraProjectKey.trim().toUpperCase();
    if (!projectKey) {
      toast.error('Project Key를 입력해주세요.');
      return;
    }

    setVerifying(true);
    setVerified(null);
    setVerifyError(null);

    try {
      const res = await jiraFetch(
        `/api/jira/${form.jiraInstance}/project/${projectKey}`
      );
      const result = await res.json();

      if (result.success && result.data) {
        // Board ID 조회 (Agile API)
        let boardId: number | null = null;
        try {
          const boardRes = await jiraFetch(
            `/api/jira/${form.jiraInstance}/agile/1.0/board?projectKeyOrId=${projectKey}`
          );
          const boardResult = await boardRes.json();
          if (boardResult.success && boardResult.data?.values?.length > 0) {
            boardId = boardResult.data.values[0].id;
          }
        } catch {
          // Board ID 조회 실패는 무시 (필수가 아님)
        }

        const v: VerifyResult = {
          key: result.data.key,
          id: result.data.id,
          name: result.data.name,
          boardId,
        };
        setVerified(v);
        setForm((prev) => ({ ...prev, name: v.key }));
        const boardInfo = boardId ? `, Board: ${boardId}` : '';
        toast.success(`프로젝트 확인: ${v.key} (ID: ${v.id}${boardInfo}) - ${v.name}`);
      } else {
        setVerifyError(
          result.error || '프로젝트를 찾을 수 없습니다.'
        );
        toast.error(
          `검증 실패: ${result.error || '해당 Key의 프로젝트가 존재하지 않습니다.'}`
        );
      }
    } catch {
      setVerifyError('API 호출 중 오류가 발생했습니다.');
      toast.error('Jira API 호출에 실패했습니다. 네트워크를 확인해주세요.');
    } finally {
      setVerifying(false);
    }
  };

  const toggleTeam = (teamId: string) => {
    setForm((prev) => ({
      ...prev,
      teamIds: prev.teamIds.includes(teamId)
        ? prev.teamIds.filter((id) => id !== teamId)
        : [...prev.teamIds, teamId],
    }));
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setIsAdding(false);
    setEditingId(null);
    setVerified(null);
    setVerifyError(null);
  };

  const handleAdd = async () => {
    if (!verified) {
      toast.error('Jira 프로젝트 검증을 먼저 진행해주세요.');
      return;
    }
    if (!form.name.trim()) {
      toast.error('프로젝트 이름을 입력해주세요.');
      return;
    }
    if (form.teamIds.length === 0) {
      toast.error('팀을 최소 하나 선택해주세요.');
      return;
    }

    setSaving(true);
    const { data, error } = await db
      .from('projects')
      .insert({
        name: form.name.trim(),
        jira_project_id: verified.id,
        jira_instance: form.jiraInstance,
        board_id: verified.boardId,
      })
      .select('id')
      .single();

    if (error || !data) {
      setSaving(false);
      toast.error(`저장 실패: ${error?.message || '알 수 없는 오류'}`);
      return;
    }

    if (form.teamIds.length > 0) {
      await db.from('project_teams').insert(
        form.teamIds.map((teamId) => ({
          project_id: data.id,
          team_id: teamId,
        }))
      );
    }

    setSaving(false);
    resetForm();
    toast.success(`${form.name.trim()} 프로젝트가 추가되었습니다.`);
    fetchData();
  };

  const handleEdit = (project: Project) => {
    setEditingId(project.id);
    setForm({
      jiraProjectKey: project.name,
      jiraInstance: project.jiraInstance,
      name: project.name,
      teamIds: [...project.teamIds],
    });
    setVerified({ key: project.name, id: project.jiraProjectId, name: project.name, boardId: project.boardId });
    setVerifyError(null);
    setIsAdding(false);
  };

  const handleEditSave = async () => {
    if (!verified) {
      toast.error('Jira 프로젝트 검증을 먼저 진행해주세요.');
      return;
    }
    if (!form.name.trim() || form.teamIds.length === 0) {
      toast.error('필수 항목을 입력해주세요.');
      return;
    }

    setSaving(true);
    const { error } = await db
      .from('projects')
      .update({
        name: form.name.trim(),
        jira_project_id: verified.id,
        jira_instance: form.jiraInstance,
        board_id: verified.boardId,
      })
      .eq('id', editingId);

    if (error) {
      setSaving(false);
      toast.error(`저장 실패: ${error.message}`);
      return;
    }

    await db.from('project_teams').delete().eq('project_id', editingId!);
    if (form.teamIds.length > 0) {
      await db.from('project_teams').insert(
        form.teamIds.map((teamId) => ({
          project_id: editingId!,
          team_id: teamId,
        }))
      );
    }

    setSaving(false);
    resetForm();
    toast.success('프로젝트 정보가 수정되었습니다.');
    fetchData();
  };

  const handleDelete = async (project: Project) => {
    const { error } = await db
      .from('projects')
      .delete()
      .eq('id', project.id);
    if (error) {
      toast.error(`삭제 실패: ${error.message}`);
      return;
    }
    toast.success(`${project.name} 프로젝트가 삭제되었습니다.`);
    fetchData();
  };

  const getTeamNames = (teamIds: string[]) => {
    return teamIds
      .map((id) => teams.find((t) => t.id === id)?.name)
      .filter(Boolean);
  };

  const handleResetVerify = () => {
    setVerified(null);
    setVerifyError(null);
    setForm((prev) => ({ ...prev, name: '', jiraProjectKey: '' }));
  };

  const formUI = (
    <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
      {verified ? (
        /* 검증 완료 상태: 읽기 전용 요약 + 다시 검증 버튼 */
        <div className="space-y-1">
          <label className="text-xs font-medium">Jira 프로젝트</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
              <CircleCheck className="h-4 w-4 text-emerald-500 shrink-0" />
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  form.jiraInstance === 'hmg'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                }`}
              >
                {form.jiraInstance === 'hmg' ? 'HMG' : 'Ignite'}
              </span>
              <span className="font-mono font-medium text-sm">{verified.key}</span>
              <span className="text-xs text-muted-foreground">
                (ID: {verified.id}{verified.boardId ? `, Board: ${verified.boardId}` : ''}) — {verified.name}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleResetVerify}
            >
              변경
            </Button>
          </div>
        </div>
      ) : (
        /* 검증 전: 인스턴스 선택 + Key 입력 */
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium">
              Jira 인스턴스 <span className="text-destructive">*</span>
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={form.jiraInstance === 'ignite' ? 'default' : 'outline'}
                onClick={() => updateForm('jiraInstance', 'ignite')}
                disabled={verifying}
              >
                {form.jiraInstance === 'ignite' && <Check className="mr-1 h-3 w-3" />}
                Ignite
              </Button>
              <Button
                type="button"
                size="sm"
                variant={form.jiraInstance === 'hmg' ? 'default' : 'outline'}
                onClick={() => updateForm('jiraInstance', 'hmg')}
                disabled={verifying}
              >
                {form.jiraInstance === 'hmg' && <Check className="mr-1 h-3 w-3" />}
                HMG
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">
              Project Key <span className="text-destructive">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                placeholder="FEHG"
                value={form.jiraProjectKey}
                onChange={(e) => updateForm('jiraProjectKey', e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && form.jiraProjectKey.trim()) {
                    e.preventDefault();
                    handleVerify();
                  }
                }}
                disabled={verifying}
                className="flex-1 font-mono"
                autoFocus
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleVerify}
                disabled={verifying || !form.jiraProjectKey.trim()}
              >
                {verifying ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="mr-1 h-3.5 w-3.5" />
                )}
                검증
              </Button>
            </div>
            {verifyError && (
              <div className="flex items-center gap-1.5 text-xs text-destructive mt-1">
                <CircleX className="h-3.5 w-3.5 shrink-0" />
                <span>{verifyError}</span>
              </div>
            )}
          </div>
        </>
      )}

      {/* 검증 성공 후 나머지 필드 */}
      {verified && (
        <>
          <div className="space-y-1">
            <label className="text-xs font-medium">
              소속 팀 <span className="text-destructive">*</span>
              <span className="text-muted-foreground font-normal ml-1">
                (복수 선택 가능)
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              {teams.map((team) => {
                const isSelected = form.teamIds.includes(team.id);
                return (
                  <Button
                    key={team.id}
                    type="button"
                    size="sm"
                    variant={isSelected ? 'default' : 'outline'}
                    onClick={() => toggleTeam(team.id)}
                  >
                    {isSelected && <Check className="mr-1 h-3 w-3" />}
                    {team.name}
                  </Button>
                );
              })}
              {teams.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  등록된 팀이 없습니다. 팀 관리에서 먼저 팀을 추가해주세요.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={resetForm} disabled={saving}>
              취소
            </Button>
            <Button
              size="sm"
              onClick={editingId ? handleEditSave : handleAdd}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              {editingId ? '저장' : '추가'}
            </Button>
          </div>
        </>
      )}

      {/* 검증 전에도 취소 버튼은 보이도록 */}
      {!verified && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={resetForm}>
            취소
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>프로젝트 관리</CardTitle>
            <CardDescription>
              Jira 프로젝트를 등록하고 팀에 연결합니다.
            </CardDescription>
          </div>
          {!isAdding && !editingId && (
            <Button
              onClick={() => {
                setIsAdding(true);
                setForm(EMPTY_FORM);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              프로젝트 추가
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
                    <th className="text-left px-4 py-2 font-medium">프로젝트명</th>
                    <th className="text-left px-4 py-2 font-medium">Project ID</th>
                    <th className="text-left px-4 py-2 font-medium">Board</th>
                    <th className="text-left px-4 py-2 font-medium">인스턴스</th>
                    <th className="text-left px-4 py-2 font-medium">소속 팀</th>
                    <th className="w-20 px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {projects.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-8 text-center text-muted-foreground"
                      >
                        등록된 프로젝트가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    projects.map((project) => (
                      <tr
                        key={project.id}
                        className={
                          editingId === project.id ? 'bg-muted/30' : undefined
                        }
                      >
                        <td className="px-4 py-2 font-medium">{project.name}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                          {project.jiraProjectId}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground font-mono">
                          {project.boardId || '-'}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              project.jiraInstance === 'hmg'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                            }`}
                          >
                            {project.jiraInstance === 'hmg' ? 'HMG' : 'Ignite'}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-1">
                            {getTeamNames(project.teamIds).map((name) => (
                              <span
                                key={name}
                                className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium"
                              >
                                {name}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex gap-1 justify-end">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleEdit(project)}
                              disabled={!!editingId || isAdding}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleDelete(project)}
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
