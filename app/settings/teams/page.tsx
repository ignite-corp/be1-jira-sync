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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Pencil,
  Trash2,
  Check,
  ChevronDown,
  ChevronUp,
  Users,
  FolderKanban,
  Star,
  Loader2,
  GitCompareArrows,
  AlertCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/lib/db';

// --- 타입 ---

interface Project {
  id: string;
  name: string;
  jiraInstance: string;
}

interface UserInfo {
  id: string;
  name: string;
}

interface SyncProfile {
  id: string;
  name: string;
  sourceProjectId: string;
  targetProjectId: string;
}

interface TargetProjectConfig {
  projectId: string;
  syncProfileId: string | null;
}

interface Team {
  id: string;
  name: string;
  createdAt: string;
  sourceProjectId: string | null;
  targets: TargetProjectConfig[];
  memberIds: string[];
}

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [syncProfiles, setSyncProfiles] = useState<SyncProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const [newTeamName, setNewTeamName] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- 데이터 로드 ---

  const fetchData = useCallback(async () => {
    const [projectsRes, usersRes, teamsRes, targetsRes, profilesRes] =
      await Promise.all([
        db.from('projects').select('id, name, jira_instance').order('name'),
        db.from('users').select('id, name, team_id').order('name'),
        db.from('teams').select('id, name, source_project_id, created_at').order('name'),
        db.from('team_target_projects').select('team_id, project_id, sync_profile_id'),
        db
          .from('sync_profiles')
          .select('id, name, source_project_id, target_project_id')
          .order('name'),
      ]);

    if (projectsRes.data) {
      setProjects(
        projectsRes.data.map((p) => ({
          id: p.id,
          name: p.name,
          jiraInstance: p.jira_instance || 'ignite',
        }))
      );
    }

    if (usersRes.data) {
      setUsers(usersRes.data.map((u) => ({ id: u.id, name: u.name })));
    }

    if (profilesRes.data) {
      setSyncProfiles(
        profilesRes.data.map((p) => ({
          id: p.id,
          name: p.name,
          sourceProjectId: p.source_project_id,
          targetProjectId: p.target_project_id,
        }))
      );
    }

    // 팀 데이터 조합
    if (teamsRes.data) {
      const targetMap: Record<string, TargetProjectConfig[]> = {};
      targetsRes.data?.forEach((t) => {
        if (!targetMap[t.team_id]) targetMap[t.team_id] = [];
        targetMap[t.team_id].push({
          projectId: t.project_id,
          syncProfileId: t.sync_profile_id || null,
        });
      });

      const memberMap: Record<string, string[]> = {};
      usersRes.data?.forEach((u) => {
        if (u.team_id) {
          if (!memberMap[u.team_id]) memberMap[u.team_id] = [];
          memberMap[u.team_id].push(u.id);
        }
      });

      setTeams(
        teamsRes.data.map((t) => ({
          id: t.id,
          name: t.name,
          createdAt: t.created_at,
          sourceProjectId: t.source_project_id,
          targets: targetMap[t.id] || [],
          memberIds: memberMap[t.id] || [],
        }))
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // --- 팀 추가 ---

  const handleAdd = async () => {
    const name = newTeamName.trim();
    if (!name) {
      toast.error('팀 이름을 입력해주세요.');
      return;
    }

    const { data, error } = await db
      .from('teams')
      .insert({ name })
      .select('id, name, source_project_id, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        toast.error('이미 존재하는 팀 이름입니다.');
      } else {
        toast.error(`추가 실패: ${error.message}`);
      }
      return;
    }

    setNewTeamName('');
    toast.success(`${name} 팀이 추가되었습니다.`);
    setExpandedId(data.id);
    setEditingId(data.id);
    fetchData();
  };

  // --- 팀 삭제 ---

  const handleDelete = async (team: Team) => {
    const { error } = await db.from('teams').delete().eq('id', team.id);
    if (error) {
      toast.error(`삭제 실패: ${error.message}`);
      return;
    }
    if (expandedId === team.id) setExpandedId(null);
    if (editingId === team.id) setEditingId(null);
    toast.success(`${team.name} 팀이 삭제되었습니다.`);
    fetchData();
  };

  // --- 편집 저장 ---

  const handleSaveEdit = async (team: Team) => {
    setSaving(true);
    try {
      // 1. 팀 기본 정보 업데이트
      await db
        .from('teams')
        .update({ source_project_id: team.sourceProjectId })
        .eq('id', team.id);

      // 2. team_target_projects 전체 삭제 후 재삽입
      await db
        .from('team_target_projects')
        .delete()
        .eq('team_id', team.id);

      if (team.targets.length > 0) {
        await db.from('team_target_projects').insert(
          team.targets.map((t) => ({
            team_id: team.id,
            project_id: t.projectId,
            sync_profile_id: t.syncProfileId || null,
          }))
        );
      }

      // 3. 사용자 team_id 업데이트
      // 먼저 이 팀에서 빠진 사용자 해제
      await db
        .from('users')
        .update({ team_id: null })
        .eq('team_id', team.id)
        .not('id', 'in', `(${team.memberIds.join(',')})`);

      // 새로 추가된 사용자 연결
      if (team.memberIds.length > 0) {
        for (const userId of team.memberIds) {
          await db
            .from('users')
            .update({ team_id: team.id })
            .eq('id', userId);
        }
      }

      toast.success('저장되었습니다.');
      setEditingId(null);
      fetchData();
    } catch {
      toast.error('저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  // --- 토글 ---

  const toggleExpand = (teamId: string) => {
    setExpandedId(expandedId === teamId ? null : teamId);
    if (editingId && editingId !== teamId) setEditingId(null);
  };

  const startEdit = (teamId: string) => {
    setEditingId(teamId);
    setExpandedId(teamId);
  };

  const cancelEdit = () => {
    setEditingId(null);
    fetchData(); // 변경사항 롤백
  };

  // --- 로컬 상태 업데이트 (편집 중) ---

  const updateTeamLocal = (teamId: string, updates: Partial<Team>) => {
    setTeams(teams.map((t) => (t.id === teamId ? { ...t, ...updates } : t)));
  };

  const handleSourceProjectChange = (teamId: string, projectId: string) => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;

    const newTargets = team.targets.filter((t) => t.projectId !== projectId);
    updateTeamLocal(teamId, {
      sourceProjectId: projectId,
      targets: newTargets,
    });
  };

  const toggleTargetProject = (teamId: string, projectId: string) => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;

    if (team.sourceProjectId === projectId) {
      toast.error('기준 프로젝트는 동기화 대상으로 선택할 수 없습니다.');
      return;
    }

    const existing = team.targets.find((t) => t.projectId === projectId);
    const newTargets = existing
      ? team.targets.filter((t) => t.projectId !== projectId)
      : [...team.targets, { projectId, syncProfileId: null }];
    updateTeamLocal(teamId, { targets: newTargets });
  };

  const setSyncProfileForTarget = (
    teamId: string,
    projectId: string,
    profileId: string | null
  ) => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;

    const newTargets = team.targets.map((t) =>
      t.projectId === projectId
        ? { ...t, syncProfileId: profileId }
        : t
    );
    updateTeamLocal(teamId, { targets: newTargets });
  };

  const toggleMember = (teamId: string, userId: string) => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;

    const newMembers = team.memberIds.includes(userId)
      ? team.memberIds.filter((id) => id !== userId)
      : [...team.memberIds, userId];
    updateTeamLocal(teamId, { memberIds: newMembers });
  };

  // --- 헬퍼 ---

  const getProjectName = (id: string) =>
    projects.find((p) => p.id === id)?.name || '-';

  const getUserName = (id: string) =>
    users.find((u) => u.id === id)?.name || '-';

  const getProfileName = (id: string) =>
    syncProfiles.find((p) => p.id === id)?.name || '-';

  // 특정 (source, target) 조합에 맞는 프로필 목록
  const getAvailableProfiles = (sourceProjectId: string | null, targetProjectId: string) => {
    if (!sourceProjectId) return [];
    return syncProfiles.filter(
      (p) => p.sourceProjectId === sourceProjectId && p.targetProjectId === targetProjectId
    );
  };

  // --- 팀 상세 뷰 (읽기 모드) ---

  const renderDetail = (team: Team) => (
    <div className="px-5 py-5 space-y-5">
      {/* 기준 프로젝트 */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <Star className="h-3.5 w-3.5" />
          기준 프로젝트
        </div>
        <div className="text-sm font-medium">
          {team.sourceProjectId ? (
            <span className="inline-flex items-center rounded-full bg-blue-50 border border-blue-200 text-blue-700 px-2.5 py-0.5 text-xs font-semibold">
              {getProjectName(team.sourceProjectId)}
            </span>
          ) : (
            <span className="text-muted-foreground">미설정</span>
          )}
        </div>
      </div>

      <div className="border-t" />

      {/* 동기화 대상 */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <FolderKanban className="h-3.5 w-3.5" />
          동기화 대상 프로젝트
        </div>
        {team.targets.length === 0 ? (
          <span className="text-sm text-muted-foreground">미설정</span>
        ) : (
          <div className="space-y-1.5">
            {team.targets.map((target) => {
              const hasProfile = !!target.syncProfileId;
              return (
                <div
                  key={target.projectId}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium min-w-[60px] justify-center">
                    {getProjectName(target.projectId)}
                  </span>
                  {hasProfile ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <GitCompareArrows className="h-3 w-3" />
                      {getProfileName(target.syncProfileId!)}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-amber-600">
                      <AlertCircle className="h-3 w-3" />
                      매핑 미설정 (동기화 불가)
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t" />

      {/* 소속 사용자 */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <Users className="h-3.5 w-3.5" />
          소속 사용자 ({team.memberIds.length}명)
        </div>
        <div className="flex flex-wrap gap-1.5">
          {team.memberIds.length === 0 ? (
            <span className="text-sm text-muted-foreground">미설정</span>
          ) : (
            team.memberIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium"
              >
                {getUserName(id)}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );

  // --- 팀 상세 뷰 (편집 모드) ---

  const renderEditDetail = (team: Team) => {
    const availableTargetProjects = projects.filter(
      (p) => p.id !== team.sourceProjectId
    );

    return (
      <div className="px-5 py-5 space-y-5">
        {/* 기준 프로젝트 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <Star className="h-3.5 w-3.5" />
            기준 프로젝트
          </div>
          <Select
            value={team.sourceProjectId || ''}
            onValueChange={(v) => handleSourceProjectChange(team.id, v)}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="프로젝트 선택" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="border-t" />

        {/* 동기화 대상 */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <FolderKanban className="h-3.5 w-3.5" />
            동기화 대상 프로젝트
          </div>

          {/* 프로젝트 선택 버튼 */}
          <div className="flex flex-wrap gap-2">
            {availableTargetProjects.map((project) => {
              const isSelected = team.targets.some(
                (t) => t.projectId === project.id
              );
              return (
                <Button
                  key={project.id}
                  type="button"
                  size="sm"
                  variant={isSelected ? 'default' : 'outline'}
                  onClick={() => toggleTargetProject(team.id, project.id)}
                >
                  {isSelected && <Check className="mr-1 h-3 w-3" />}
                  {project.name}
                </Button>
              );
            })}
          </div>

          {/* 선택된 대상별 필드 매핑 선택 */}
          {team.targets.length > 0 && (
            <div className="space-y-2 pl-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <GitCompareArrows className="h-3.5 w-3.5" />
                대상별 필드 매핑 설정
              </div>
              <div className="space-y-2">
                {team.targets.map((target) => {
                  const available = getAvailableProfiles(
                    team.sourceProjectId,
                    target.projectId
                  );
                  return (
                    <div
                      key={target.projectId}
                      className="flex items-center gap-3"
                    >
                      <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium min-w-[60px] justify-center shrink-0">
                        {getProjectName(target.projectId)}
                      </span>
                      <span className="text-muted-foreground text-xs shrink-0">→</span>
                      {available.length === 0 ? (
                        <span className="text-xs text-amber-600 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          사용 가능한 필드 매핑이 없습니다
                        </span>
                      ) : (
                        <Select
                          value={target.syncProfileId || 'none'}
                          onValueChange={(v) =>
                            setSyncProfileForTarget(
                              team.id,
                              target.projectId,
                              v === 'none' ? null : v
                            )
                          }
                        >
                          <SelectTrigger className="w-64 h-8 text-xs">
                            <SelectValue placeholder="필드 매핑 선택..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              <span className="text-muted-foreground">
                                선택 안함
                              </span>
                            </SelectItem>
                            {available.map((profile) => (
                              <SelectItem key={profile.id} value={profile.id}>
                                {profile.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="border-t" />

        {/* 소속 사용자 */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <Users className="h-3.5 w-3.5" />
            소속 사용자
          </div>
          <div className="flex flex-wrap gap-2">
            {users.map((user) => {
              const isSelected = team.memberIds.includes(user.id);
              return (
                <Button
                  key={user.id}
                  type="button"
                  size="sm"
                  variant={isSelected ? 'default' : 'outline'}
                  onClick={() => toggleMember(team.id, user.id)}
                >
                  {isSelected && <Check className="mr-1 h-3 w-3" />}
                  {user.name}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t">
          <Button size="sm" variant="outline" onClick={cancelEdit} disabled={saving}>
            취소
          </Button>
          <Button
            size="sm"
            onClick={() => handleSaveEdit(team)}
            disabled={saving}
          >
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            저장
          </Button>
        </div>
      </div>
    );
  };

  // --- 렌더링 ---

  return (
    <div className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>팀 관리</CardTitle>
          <CardDescription>
            팀을 추가하고, 기준 프로젝트 / 동기화 대상 / 필드 매핑 / 소속 사용자를
            설정합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 추가 폼 */}
          <div className="flex gap-2">
            <Input
              placeholder="팀 이름 입력"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Button onClick={handleAdd} className="shrink-0">
              <Plus className="mr-2 h-4 w-4" />
              추가
            </Button>
          </div>

          {/* 팀 목록 */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {teams.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  등록된 팀이 없습니다.
                </div>
              ) : (
                teams.map((team) => {
                  const isExpanded = expandedId === team.id;
                  const isEditing = editingId === team.id;
                  const activeTargets = team.targets.filter(
                    (t) => t.syncProfileId
                  ).length;

                  return (
                    <div key={team.id}>
                      {/* 팀 헤더 */}
                      <div className="flex items-center justify-between px-4 py-3">
                        <button
                          className="flex items-center gap-2 flex-1 text-left"
                          onClick={() => toggleExpand(team.id)}
                        >
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="font-medium">{team.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {team.sourceProjectId
                              ? getProjectName(team.sourceProjectId)
                              : '기준 미설정'}
                            {' · '}
                            대상 {team.targets.length}개
                            {team.targets.length > 0 && activeTargets < team.targets.length && (
                              <span className="text-amber-600">
                                {' '}(매핑 {activeTargets}/{team.targets.length})
                              </span>
                            )}
                            {' · '}
                            {team.memberIds.length}명
                          </span>
                        </button>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => startEdit(team.id)}
                            disabled={!!editingId}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => handleDelete(team)}
                            disabled={!!editingId}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>

                      {/* 상세 영역 */}
                      {isExpanded && (
                        <div className="border-t bg-muted/20">
                          {isEditing
                            ? renderEditDetail(team)
                            : renderDetail(team)}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
