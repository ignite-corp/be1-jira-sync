'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertTriangle,
  ArrowRight,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { toast } from 'sonner';
import { db } from '@/lib/db';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { useCurrentUser } from '@/contexts/user-context';
import { SyncLogger } from '@/lib/services/sync/logger';
import {
  AssigneeAccountNotMappedError,
  BidirectionalOrchestrator,
  CurrentSprintNotFoundError,
  type BidirectionalPlan,
  type ConflictItem,
  type MissingItem,
  type SyncDirection,
  type TicketRef,
} from '@/lib/services/sync/bidirectional-orchestrator';
import { BidirectionalExecutor } from '@/lib/services/sync/bidirectional-executor';
import type { SyncLog } from '@/lib/services/sync/types';

interface TeamSyncTarget {
  projectId: string;
  projectName: string;
  syncProfileId: string;
  syncProfileName: string;
  sourceProjectName: string;
}

/** 충돌 항목의 고유 키 (펼침 상태/처리 상태 추적용) */
/**
 * 항목 키. 전체 비교에서는 여러 프로필이 한 화면에 뜨는데,
 * 같은 BEDEV1 티켓이 KQ/AUTOWAY 양쪽 계획에 나올 수 있어 프로필 id 로 반드시 구분해야 한다.
 */
const conflictKey = (profileId: string, item: ConflictItem) =>
  `cf:${profileId}:${item.source.key}:${item.target.key}`;

const missingKey = (profileId: string, direction: 'toTarget' | 'toSource', ticketKey: string) =>
  `${direction === 'toTarget' ? 'ct' : 'cs'}:${profileId}:${ticketKey}`;

/** 전체 비교 선택값 */
const ALL_TARGETS = 'ALL';

/** 처리 완료된 항목 표시용 */
interface DoneMark {
  label: string;
  success: boolean;
  /** 새로 생성된 티켓 키 (있으면 배지를 링크로 만든다) */
  createdKey?: string;
  createdInstance?: 'ignite' | 'hmg';
  /** 성공했지만 반영하지 못한 값이 있을 때의 사유 */
  warnings?: string[];
}

export default function HomePage() {
  const { currentUser } = useCurrentUser();
  const router = useRouter();

  useEffect(() => {
    if (!currentUser) router.replace('/select-user');
  }, [currentUser, router]);

  const [teamSyncTargets, setTeamSyncTargets] = useState<TeamSyncTarget[]>([]);
  // 기본은 전체 비교 - 선택하지 않아도 바로 비교를 누를 수 있다
  const [selectedProfileId, setSelectedProfileId] = useState<string>(ALL_TARGETS);
  const [isComparing, setIsComparing] = useState(false);
  const [plans, setPlans] = useState<BidirectionalPlan[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [doneKeys, setDoneKeys] = useState<Map<string, DoneMark>>(new Map());
  // `${profileId}:${direction}` 형태. 여러 계획이 떠 있어도 어느 버튼이 도는지 구분한다
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmBulkOverwrite, setConfirmBulkOverwrite] = useState<BidirectionalPlan | null>(
    null
  );
  const [bulkOverwriteBusy, setBulkOverwriteBusy] = useState(false);
  const [showInSync, setShowInSync] = useState(false);

  // 팀 동기화 대상 조회
  useEffect(() => {
    if (!currentUser?.teamId) return;

    const loadTargets = async () => {
      const { data: teamData } = await db
        .from('teams')
        .select('source_project_id')
        .eq('id', currentUser.teamId)
        .single();

      if (!teamData?.source_project_id) return;

      const { data: projects } = await db.from('projects').select('id, name');
      const projectMap = new Map(projects?.map((p) => [p.id, p.name]) || []);

      const { data: targets } = await db
        .from('team_target_projects')
        .select('project_id, sync_profile_id')
        .eq('team_id', currentUser.teamId);

      if (!targets) return;

      const profileIds = targets
        .map((t) => t.sync_profile_id)
        .filter(Boolean) as string[];

      const profileMap = new Map<string, string>();
      if (profileIds.length > 0) {
        const { data: profiles } = await db
          .from('sync_profiles')
          .select('id, name')
          .in('id', profileIds);
        profiles?.forEach((p) => profileMap.set(p.id, p.name));
      }

      const sourceProjectName = projectMap.get(teamData.source_project_id) || '?';

      setTeamSyncTargets(
        targets
          .filter((t) => t.sync_profile_id)
          .map((t) => ({
            projectId: t.project_id,
            projectName: projectMap.get(t.project_id) || '?',
            syncProfileId: t.sync_profile_id!,
            syncProfileName: profileMap.get(t.sync_profile_id!) || '?',
            sourceProjectName,
          }))
      );
    };

    loadTargets();
  }, [currentUser?.teamId]);

  const makeLogger = useCallback(
    () => new SyncLogger((log) => setLogs((prev) => [...prev, log])),
    []
  );

  const handleCompare = async () => {
    if (!selectedProfileId) {
      toast.error('동기화 대상을 선택해주세요.');
      return;
    }
    if (!currentUser?.igniteAccountId) {
      toast.error('담당자 계정 정보가 없습니다. 사용자 설정을 확인해주세요.');
      return;
    }

    const targets =
      selectedProfileId === ALL_TARGETS
        ? teamSyncTargets
        : teamSyncTargets.filter((t) => t.syncProfileId === selectedProfileId);

    if (targets.length === 0) {
      toast.error('비교할 동기화 대상이 없습니다.');
      return;
    }

    setIsComparing(true);
    setPlans([]);
    setLogs([]);
    setDoneKeys(new Map());
    setExpanded(new Set());

    const logger = makeLogger();
    const orchestrator = new BidirectionalOrchestrator(logger);
    const results: BidirectionalPlan[] = [];
    const failures: string[] = [];

    // 전체 비교에서도 하나가 실패했다고 나머지를 버리지 않는다.
    // (예: 어떤 프로젝트만 이번 달 스프린트가 없는 경우)
    for (const target of targets) {
      try {
        const result = await orchestrator.buildPlan(target.syncProfileId, {
          // 현재 스프린트 + 본인 담당 티켓으로 한정한다.
          // KQ 같은 공용 프로젝트는 스프린트에 여러 팀 티켓이 섞여 있다.
          assigneeAccountId: currentUser!.igniteAccountId,
        });
        results.push(result);
      } catch (error) {
        const reason =
          error instanceof CurrentSprintNotFoundError ||
          error instanceof AssigneeAccountNotMappedError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        failures.push(`${target.projectName}: ${reason}`);
        logger.error(`${target.projectName} 비교 실패 - ${reason}`);
      }
    }

    setPlans(results);

    // 덮어쓸 방향을 고르려면 무엇이 다른지 먼저 봐야 하므로 충돌 항목은 펼친 채로 시작한다
    // (개별 접기는 그대로 가능)
    setExpanded(
      new Set(
        results.flatMap((p) => p.conflicts.map((c) => conflictKey(p.profileId, c)))
      )
    );
    setIsComparing(false);

    const actionable = results.reduce(
      (sum, p) => sum + p.createInTarget.length + p.createInSource.length + p.conflicts.length,
      0
    );

    if (failures.length > 0) {
      toast.error(`${failures.length}개 대상 비교 실패`, {
        description: failures.join('\n'),
      });
    } else if (actionable === 0) {
      toast.success('양쪽이 모두 동일합니다. 처리할 항목이 없습니다.');
    } else {
      toast.success(`처리할 항목 ${actionable}건을 찾았습니다.`);
    }
  };

  const markBusy = (key: string, busy: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** 한 건 생성 (개별 버튼과 전체 생성이 같은 경로를 쓴다) */
  const createOne = async (
    plan: BidirectionalPlan,
    item: MissingItem,
    direction: 'toTarget' | 'toSource'
  ): Promise<boolean> => {
    const key = missingKey(plan.profileId, direction, item.ticket.key);
    if (doneKeys.get(key)?.success) return true; // 이미 만든 건 건너뛴다

    markBusy(key, true);
    try {
      const executor = new BidirectionalExecutor(makeLogger());
      const result =
        direction === 'toTarget'
          ? await executor.createInTarget(item.raw, plan.profileId)
          : await executor.createInSource(item.raw, plan.profileId);

      const createdKey = direction === 'toTarget' ? result.targetKey : result.sourceKey;
      const createdInstance =
        direction === 'toTarget' ? plan.targetInstance : plan.sourceInstance;

      setDoneKeys((prev) =>
        new Map(prev).set(key, {
          label: result.success ? `${createdKey} 생성됨` : (result.error ?? '실패'),
          success: result.success,
          createdKey: result.success ? createdKey : undefined,
          createdInstance: result.success ? createdInstance : undefined,
          warnings: result.warnings?.length ? result.warnings : undefined,
        })
      );

      if (result.warnings?.length) {
        toast.warning(`${item.ticket.key}: 일부 값이 반영되지 않았습니다`, {
          description: result.warnings.join('\n'),
        });
      }

      return result.success;
    } finally {
      markBusy(key, false);
    }
  };

  const handleCreateOne = async (
    plan: BidirectionalPlan,
    item: MissingItem,
    direction: 'toTarget' | 'toSource'
  ) => {
    const ok = await createOne(plan, item, direction);
    if (ok) toast.success(`${item.ticket.key} 생성 완료`);
    else toast.error(`${item.ticket.key} 생성 실패`);
  };

  /**
   * 전체 생성. Jira 를 몰아치지 않도록 순차 실행한다.
   * 이미 생성된 항목은 건너뛰고, 하나가 실패해도 나머지는 계속 진행한다.
   */
  const handleCreateAll = async (
    plan: BidirectionalPlan,
    direction: 'toTarget' | 'toSource'
  ) => {
    const items = direction === 'toTarget' ? plan.createInTarget : plan.createInSource;
    const pending = items.filter(
      (i) => !doneKeys.get(missingKey(plan.profileId, direction, i.ticket.key))?.success
    );

    if (pending.length === 0) {
      toast.info('생성할 항목이 없습니다.');
      return;
    }

    setBulkBusy(`${plan.profileId}:${direction}`);
    setBulkProgress({ done: 0, total: pending.length });

    let succeeded = 0;
    let failed = 0;

    try {
      for (const [idx, item] of pending.entries()) {
        const ok = await createOne(plan, item, direction);
        if (ok) succeeded++;
        else failed++;
        setBulkProgress({ done: idx + 1, total: pending.length });
      }
    } finally {
      setBulkBusy(null);
      setBulkProgress(null);
    }

    if (failed === 0) toast.success(`${succeeded}건 생성 완료`);
    else toast.warning(`생성 완료 (성공 ${succeeded}, 실패 ${failed})`);
  };

  const handleOverwrite = async (
    plan: BidirectionalPlan,
    item: ConflictItem,
    direction: SyncDirection
  ) => {
    const key = conflictKey(plan.profileId, item);
    markBusy(key, true);
    try {
      const executor = new BidirectionalExecutor(makeLogger());
      const result = await executor.overwrite(
        direction,
        item.sourceRaw,
        item.targetRaw,
        plan.profileId
      );
      setDoneKeys((prev) =>
        new Map(prev).set(key, {
          label: result.success
            ? direction === 'sourceToTarget'
              ? `${plan.targetProjectKey} 에 반영됨`
              : `${plan.sourceProjectKey} 에 반영됨`
            : (result.error ?? '실패'),
          success: result.success,
          warnings: result.warnings?.length ? result.warnings : undefined,
        })
      );
      if (!result.success) {
        toast.error(`덮어쓰기 실패: ${result.error}`);
      } else if (result.warnings?.length) {
        toast.warning('일부 값이 반영되지 않았습니다', {
          description: result.warnings.join('\n'),
        });
      } else {
        toast.success('덮어쓰기 완료');
      }
    } finally {
      markBusy(key, false);
    }
  };

  /**
   * 확인 필요 항목을 전부 BEDEV1 → 대상 방향으로 덮어쓴다.
   *
   * 대상이 더 최신인 항목까지 덮어쓰므로 되돌릴 수 없다.
   * 그래서 확인 창을 거친 뒤에만 호출된다.
   */
  const handleOverwriteAll = async (plan: BidirectionalPlan) => {
    setConfirmBulkOverwrite(null);

    const pending = plan.conflicts.filter(
      (c) => !doneKeys.get(conflictKey(plan.profileId, c))?.success
    );
    if (pending.length === 0) {
      toast.info('덮어쓸 항목이 없습니다.');
      return;
    }

    setBulkOverwriteBusy(true);
    setBulkProgress({ done: 0, total: pending.length });

    let succeeded = 0;
    let failed = 0;

    try {
      const executor = new BidirectionalExecutor(makeLogger());

      for (const [idx, item] of pending.entries()) {
        const key = conflictKey(plan.profileId, item);
        markBusy(key, true);
        try {
          const result = await executor.overwrite(
            'sourceToTarget',
            item.sourceRaw,
            item.targetRaw,
            plan.profileId
          );

          setDoneKeys((prev) =>
            new Map(prev).set(key, {
              label: result.success
                ? `${plan.targetProjectKey} 에 반영됨`
                : (result.error ?? '실패'),
              success: result.success,
              warnings: result.warnings?.length ? result.warnings : undefined,
            })
          );

          if (result.success) succeeded++;
          else failed++;
        } finally {
          markBusy(key, false);
        }
        setBulkProgress({ done: idx + 1, total: pending.length });
      }
    } finally {
      setBulkOverwriteBusy(false);
      setBulkProgress(null);
    }

    if (failed === 0) toast.success(`${succeeded}건 덮어쓰기 완료`);
    else toast.warning(`덮어쓰기 완료 (성공 ${succeeded}, 실패 ${failed})`);
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 아직 생성되지 않은 항목 수 */
  const countPending = (
    plan: BidirectionalPlan,
    direction: 'toTarget' | 'toSource',
    items: MissingItem[]
  ) =>
    items.filter(
      (i) => !doneKeys.get(missingKey(plan.profileId, direction, i.ticket.key))?.success
    ).length;

  /** 아직 처리하지 않은 충돌 항목 */
  const pendingConflictsOf = (plan: BidirectionalPlan) =>
    plan.conflicts.filter((c) => !doneKeys.get(conflictKey(plan.profileId, c))?.success);
  /** 그 중 대상이 더 최신이라 덮어쓰면 최신 내용이 사라지는 항목 */
  const riskyConflictsOf = (plan: BidirectionalPlan) =>
    pendingConflictsOf(plan).filter((c) => c.suggestedDirection === 'targetToSource');

  const issueUrl = (key: string, instance: 'ignite' | 'hmg') =>
    `${instance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE}/browse/${key}`;

  return (
    <main className="h-screen bg-background flex flex-col">
      <header className="border-b">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Jira 통합 관리</h1>
            <p className="text-sm text-muted-foreground">
              현재 스프린트를 양쪽에서 비교하고, 덮어쓰기는 확인 후 진행합니다
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/create-ticket">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                티켓 생성
              </Button>
            </Link>
            <Link href="/settings">
              <Button variant="outline" size="icon">
                <Settings className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <div className="flex-1 container mx-auto px-6 py-6 overflow-hidden">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] h-full">
          {/* 왼쪽: 비교 결과 */}
          <Card className="flex h-full flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>비교 결과</CardTitle>
              <CardDescription>
                {plans.length === 1
                  ? `${plans[0].sourceProjectKey} "${plans[0].sourceSprintName}" ↔ ${plans[0].targetProjectKey} "${plans[0].targetSprintName}"`
                  : plans.length > 1
                    ? `${plans.length}개 대상 비교 결과`
                    : '동기화 대상을 선택하고 비교를 실행하세요'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0">
              <ScrollArea className="h-full px-6 pb-6">
                {/* 대상 선택 */}
                <div className="flex gap-2 pb-4">
                  <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="동기화 대상을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_TARGETS}>
                        전체
                        {teamSyncTargets.length > 0 && ` (${teamSyncTargets.length}개 대상)`}
                      </SelectItem>
                      {teamSyncTargets.map((target) => (
                        <SelectItem key={target.projectId} value={target.syncProfileId}>
                          {target.sourceProjectName} ↔ {target.projectName} (
                          {target.syncProfileName})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleCompare}
                    disabled={!selectedProfileId || isComparing || teamSyncTargets.length === 0}
                    className="min-w-[110px]"
                  >
                    <RefreshCw className={`mr-2 h-4 w-4 ${isComparing ? 'animate-spin' : ''}`} />
                    {isComparing ? '비교 중...' : '비교'}
                  </Button>
                </div>

                {plans.length === 0 && !isComparing && (
                  <p className="text-sm text-muted-foreground italic py-8">
                    비교를 실행하면 양쪽 현재 월 스프린트의 티켓을 비교합니다.
                  </p>
                )}

                {plans.map((plan) => {
                  const pendingConflicts = pendingConflictsOf(plan);
                  return (
                  <div key={plan.profileId} className="space-y-6 mb-10">
                    {/* 어느 대상의 결과인지 (전체 비교에서 특히 필요) */}
                    {plans.length > 1 && (
                      <h2 className="text-base font-bold border-b pb-2">
                        {plan.sourceProjectKey} ↔ {plan.targetProjectKey}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          &quot;{plan.sourceSprintName}&quot; ↔ &quot;{plan.targetSprintName}&quot;
                        </span>
                      </h2>
                    )}

                    {/* 요약 */}
                    <div className="p-4 bg-muted/30 rounded-lg border inline-grid grid-cols-[auto_auto] gap-x-6 gap-y-2 text-sm">
                      <span className="text-muted-foreground">
                        {plan.targetProjectKey} 에 생성
                      </span>
                      <span className="font-bold text-green-600">
                        {plan.createInTarget.length}개
                      </span>
                      <span className="text-muted-foreground">
                        {plan.sourceProjectKey} 에 생성
                      </span>
                      <span className="font-bold text-green-600">
                        {plan.createInSource.length}개
                      </span>
                      <span className="text-muted-foreground">확인 필요</span>
                      <span className="font-bold text-yellow-600">
                        {plan.conflicts.length}개
                      </span>
                      <span className="text-muted-foreground">이미 동일</span>
                      <span className="font-bold text-foreground">{plan.inSync.length}개</span>
                    </div>

                    {/* 요구사항 1 */}
                    <Section
                      title={`${plan.sourceProjectKey} 에만 있음 → ${plan.targetProjectKey} 에 생성`}
                      count={plan.createInTarget.length}
                      action={
                        <CreateAllButton
                          label={`${plan.targetProjectKey} 에 전체 생성`}
                          pending={countPending(plan, 'toTarget', plan.createInTarget)}
                          running={bulkBusy === `${plan.profileId}:toTarget`}
                          disabled={bulkBusy !== null}
                          progress={
                            bulkBusy === `${plan.profileId}:toTarget` ? bulkProgress : null
                          }
                          onClick={() => handleCreateAll(plan, 'toTarget')}
                        />
                      }
                    >
                      {plan.createInTarget.map((item) => {
                        const key = missingKey(plan.profileId, 'toTarget', item.ticket.key);
                        const done = doneKeys.get(key);
                        return (
                          <div
                            key={key}
                            className="flex items-center gap-2 py-2 border-b last:border-b-0"
                          >
                            <a
                              href={issueUrl(item.ticket.key, plan.sourceInstance)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline inline-flex items-center gap-1 shrink-0 font-medium"
                            >
                              {item.ticket.key}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            <span className="flex-1 min-w-0 truncate text-sm">
                              {item.ticket.summary}
                            </span>
                            <StatusBadge ticket={item.ticket} />
                            {done ? (
                              <DoneBadge mark={done} />
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => handleCreateOne(plan, item, 'toTarget')}
                                disabled={busyKeys.has(key) || bulkBusy !== null}
                              >
                                {busyKeys.has(key) ? (
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <Plus className="mr-1 h-3 w-3" />
                                )}
                                {plan.targetProjectKey} 에 생성
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </Section>

                    {/* 요구사항 2 */}
                    <Section
                      title={`${plan.targetProjectKey} 에만 있음 → ${plan.sourceProjectKey} 에 생성`}
                      count={plan.createInSource.length}
                      action={
                        <CreateAllButton
                          label={`${plan.sourceProjectKey} 에 전체 생성`}
                          pending={countPending(plan, 'toSource', plan.createInSource)}
                          running={bulkBusy === `${plan.profileId}:toSource`}
                          disabled={bulkBusy !== null}
                          progress={
                            bulkBusy === `${plan.profileId}:toSource` ? bulkProgress : null
                          }
                          onClick={() => handleCreateAll(plan, 'toSource')}
                        />
                      }
                    >
                      {plan.createInSource.map((item) => {
                        const key = missingKey(plan.profileId, 'toSource', item.ticket.key);
                        const done = doneKeys.get(key);
                        return (
                          <div
                            key={key}
                            className="flex items-center gap-2 py-2 border-b last:border-b-0"
                          >
                            <a
                              href={issueUrl(item.ticket.key, plan.targetInstance)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline inline-flex items-center gap-1 shrink-0 font-medium"
                            >
                              {item.ticket.key}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            <span className="flex-1 min-w-0 truncate text-sm">
                              {item.ticket.summary}
                            </span>
                            <StatusBadge ticket={item.ticket} />
                            {done ? (
                              <DoneBadge mark={done} />
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => handleCreateOne(plan, item, 'toSource')}
                                disabled={busyKeys.has(key) || bulkBusy !== null}
                              >
                                {busyKeys.has(key) ? (
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                ) : (
                                  <Plus className="mr-1 h-3 w-3" />
                                )}
                                {plan.sourceProjectKey} 에 생성
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </Section>

                    {/* 요구사항 3 */}
                    <Section
                      title="양쪽에 있고 내용이 다름 → 덮어쓸 방향을 확인하세요"
                      count={plan.conflicts.length}
                      action={
                        pendingConflicts.length > 0 || bulkOverwriteBusy ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={bulkBusy !== null || bulkOverwriteBusy}
                            onClick={() => setConfirmBulkOverwrite(plan)}
                          >
                            {bulkOverwriteBusy ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <ArrowRight className="mr-1 h-3 w-3" />
                            )}
                            {bulkOverwriteBusy && bulkProgress
                              ? `덮어쓰는 중 (${bulkProgress.done}/${bulkProgress.total})`
                              : `${plan.sourceProjectKey} → ${plan.targetProjectKey} 일괄 덮어쓰기 (${pendingConflicts.length}건)`}
                          </Button>
                        ) : null
                      }
                    >
                      {plan.conflicts.map((item) => {
                        const key = conflictKey(plan.profileId, item);
                        const done = doneKeys.get(key);
                        const isOpen = expanded.has(key);
                        const suggestSourceToTarget =
                          item.suggestedDirection === 'sourceToTarget';

                        return (
                          <div key={key} className="py-3 border-b last:border-b-0">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => toggleExpanded(key)}
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                aria-label={isOpen ? '접기' : '펼치기'}
                              >
                                {isOpen ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </button>
                              <a
                                href={issueUrl(item.source.key, plan.sourceInstance)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline shrink-0 font-medium"
                              >
                                {item.source.key}
                              </a>
                              <ArrowLeftRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              <a
                                href={issueUrl(item.target.key, plan.targetInstance)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline shrink-0 font-medium"
                              >
                                {item.target.key}
                              </a>
                              <span className="flex-1 min-w-0 truncate text-sm text-muted-foreground">
                                {item.source.summary}
                              </span>
                              <StatusBadge ticket={item.source} />
                              <StatusBadge ticket={item.target} />
                              <span className="shrink-0 text-xs font-semibold text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-0.5">
                                {item.comparison.changed.length}개 항목 다름
                              </span>
                            </div>

                            {isOpen && (
                              <div className="mt-3 ml-6 rounded-lg border overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead className="bg-muted/50">
                                    <tr>
                                      <th className="text-left font-medium px-3 py-2 whitespace-nowrap">
                                        항목
                                      </th>
                                      <th className="text-left font-medium px-3 py-2">
                                        {plan.sourceProjectKey}
                                      </th>
                                      <th className="text-left font-medium px-3 py-2">
                                        {plan.targetProjectKey}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {item.comparison.changed.map((diff) => (
                                      <tr key={diff.targetField} className="border-t align-top">
                                        <td className="px-3 py-2 whitespace-nowrap font-medium">
                                          {diff.label}
                                        </td>
                                        <td className="px-3 py-2 whitespace-pre-wrap break-words text-blue-700">
                                          {diff.sourceDisplay}
                                        </td>
                                        <td className="px-3 py-2 whitespace-pre-wrap break-words text-orange-700">
                                          {diff.targetDisplay}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            <div className="mt-3 ml-6 flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-muted-foreground">
                                최종수정{' '}
                                {suggestSourceToTarget
                                  ? `${plan.sourceProjectKey} 쪽이 최신`
                                  : `${plan.targetProjectKey} 쪽이 최신`}
                              </span>
                              {done ? (
                                <DoneBadge mark={done} />
                              ) : (
                                <>
                                  <Button
                                    size="sm"
                                    disabled={busyKeys.has(key) || bulkOverwriteBusy}
                                    onClick={() =>
                                      handleOverwrite(
                                        plan,
                                        item,
                                        suggestSourceToTarget
                                          ? 'sourceToTarget'
                                          : 'targetToSource'
                                      )
                                    }
                                  >
                                    {busyKeys.has(key) ? (
                                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    ) : (
                                      <ArrowRight className="mr-1 h-3 w-3" />
                                    )}
                                    {suggestSourceToTarget
                                      ? `${plan.sourceProjectKey} → ${plan.targetProjectKey}`
                                      : `${plan.targetProjectKey} → ${plan.sourceProjectKey}`}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busyKeys.has(key) || bulkOverwriteBusy}
                                    onClick={() =>
                                      handleOverwrite(
                                        plan,
                                        item,
                                        suggestSourceToTarget
                                          ? 'targetToSource'
                                          : 'sourceToTarget'
                                      )
                                    }
                                  >
                                    {suggestSourceToTarget
                                      ? `${plan.targetProjectKey} → ${plan.sourceProjectKey}`
                                      : `${plan.sourceProjectKey} → ${plan.targetProjectKey}`}
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </Section>

                    {/* 이미 동일 */}
                    {plan.inSync.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={() => setShowInSync((v) => !v)}
                          className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
                        >
                          {showInSync ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          이미 동일 ({plan.inSync.length}개) — 건너뜀
                        </button>
                        {showInSync && (
                          <div className="mt-2 pl-6 space-y-1">
                            {plan.inSync.map((item) => (
                              <div
                                key={`is:${plan.profileId}:${item.source.key}`}
                                className="text-sm text-muted-foreground flex items-center gap-2"
                              >
                                <Check className="h-3 w-3 text-green-600 shrink-0" />
                                <span className="shrink-0">
                                  {item.source.key} ↔ {item.target.key}
                                </span>
                                <span className="truncate">{item.source.summary}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 범위 밖 */}
                    {plan.skipped.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
                          범위 밖 ({plan.skipped.length}개)
                        </h3>
                        <div className="pl-2 space-y-1">
                          {plan.skipped.map((item, idx) => (
                            <div key={idx} className="text-sm text-muted-foreground">
                              <span className="font-medium">{item.key}</span> — {item.reason}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* 오른쪽: 로그 */}
          <Card className="flex h-full flex-col overflow-hidden">
            <CardHeader>
              <CardTitle>로그</CardTitle>
              <CardDescription>비교 및 실행 기록</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 p-0 overflow-hidden">
              <ScrollArea className="h-full px-6 pb-6">
                <div className="space-y-2 font-mono text-xs leading-relaxed">
                  {logs.length === 0 ? (
                    <p className="text-muted-foreground italic">기록 없음</p>
                  ) : (
                    logs.map((log, idx) => (
                      <div
                        key={idx}
                        className={
                          log.level === 'success'
                            ? 'text-green-600'
                            : log.level === 'error'
                              ? 'text-red-600'
                              : log.level === 'warning'
                                ? 'text-yellow-600'
                                : 'text-blue-600'
                        }
                      >
                        <span className="text-muted-foreground">[{log.timestamp}]</span>{' '}
                        <span className="whitespace-pre-wrap">{log.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 일괄 덮어쓰기 확인 — 되돌릴 수 없는 작업이라 반드시 한 번 묻는다 */}
      <Dialog
        open={confirmBulkOverwrite !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmBulkOverwrite(null);
        }}
      >
        <DialogContent>
          {confirmBulkOverwrite &&
            (() => {
              const target = confirmBulkOverwrite;
              const pending = pendingConflictsOf(target);
              const risky = riskyConflictsOf(target);
              return (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-destructive">
                      <AlertTriangle className="h-5 w-5" />
                      일괄 덮어쓰기
                    </DialogTitle>
                    <DialogDescription asChild>
                      <div className="space-y-3">
                        <p>
                          {target.sourceProjectKey} 의 내용으로{' '}
                          <span className="font-semibold">{target.targetProjectKey}</span> 티켓{' '}
                          <span className="font-semibold">{pending.length}건</span> 을 덮어씁니다.
                        </p>

                        {risky.length > 0 ? (
                          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
                            <p className="font-semibold text-destructive">
                              이 중 {risky.length}건은 {target.targetProjectKey} 쪽이 더
                              최신입니다. 덮어쓰면 최신 내용이 사라집니다.
                            </p>
                            <ul className="space-y-0.5">
                              {risky.map((c) => (
                                <li
                                  key={conflictKey(target.profileId, c)}
                                  className="font-mono text-xs"
                                >
                                  {c.source.key} → {c.target.key}
                                  <span className="ml-2 font-sans text-muted-foreground">
                                    {c.comparison.changed.map((d) => d.label).join(', ')}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <p className="text-muted-foreground">
                            모두 {target.sourceProjectKey} 쪽이 더 최신이라 최신 내용이
                            사라지지는 않습니다.
                          </p>
                        )}

                        <p className="text-muted-foreground">되돌릴 수 없습니다.</p>
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirmBulkOverwrite(null)}>
                      취소
                    </Button>
                    <Button onClick={() => handleOverwriteAll(target)}>
                      {pending.length}건 덮어쓰기
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold">
          {title} <span className="text-muted-foreground">({count}개)</span>
        </h3>
        {action}
      </div>
      <div className="rounded-lg border px-3">{children}</div>
    </div>
  );
}

/** 티켓 진행상태 배지 — 이미 완료된/불필요한 항목을 목록에서 바로 구분하기 위한 표시 */
function StatusBadge({ ticket }: { ticket: TicketRef }) {
  if (!ticket.statusName) return null;

  // 상태 이름은 프로젝트/언어마다 달라서 statusCategory 로 색을 정한다
  const category = ticket.statusCategoryKey;
  const className =
    category === 'done'
      ? 'text-green-700 bg-green-50 border-green-200'
      : category === 'indeterminate'
        ? 'text-blue-700 bg-blue-50 border-blue-200'
        : 'text-gray-600 bg-gray-50 border-gray-200';

  return (
    <span
      className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded border ${className}`}
      title={`진행상태: ${ticket.statusName}`}
    >
      {ticket.statusName}
    </span>
  );
}

function DoneBadge({ mark }: { mark: DoneMark }) {
  const hasWarning = mark.success && !!mark.warnings?.length;

  // 일부만 반영된 것을 "완료" 로 보여주면 안 된다
  const className = `shrink-0 text-xs font-semibold px-2 py-0.5 rounded border ${
    !mark.success
      ? 'text-red-700 bg-red-50 border-red-200'
      : hasWarning
        ? 'text-yellow-800 bg-yellow-50 border-yellow-300'
        : 'text-green-700 bg-green-50 border-green-200'
  }`;

  const icon = !mark.success ? '✗ ' : hasWarning ? '⚠ ' : '✓ ';
  const suffix = hasWarning ? ' (일부 미반영)' : '';
  const title = mark.warnings?.join('\n');

  // 생성된 티켓은 바로 열어볼 수 있게 링크로 만든다
  const badge =
    mark.success && mark.createdKey ? (
      <a
        href={`${
          mark.createdInstance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE
        }/browse/${mark.createdKey}`}
        target="_blank"
        rel="noopener noreferrer"
        className={`${className} hover:underline inline-flex items-center gap-1`}
        title={title}
      >
        {icon}
        {mark.label}
        {suffix}
        <ExternalLink className="h-3 w-3" />
      </a>
    ) : (
      <span className={className} title={title}>
        {icon}
        {mark.label}
        {suffix}
      </span>
    );

  if (!hasWarning) return badge;

  // 왜 일부가 빠졌는지 바로 보이게 사유를 함께 노출한다
  return (
    <span className="shrink-0 flex flex-col items-end gap-1">
      {badge}
      <span className="text-xs text-yellow-800 text-right max-w-md">
        {mark.warnings!.join(' / ')}
      </span>
    </span>
  );
}

function CreateAllButton({
  label,
  pending,
  running,
  disabled,
  progress,
  onClick,
}: {
  label: string;
  pending: number;
  running: boolean;
  disabled: boolean;
  progress: { done: number; total: number } | null;
  onClick: () => void;
}) {
  if (pending === 0 && !running) return null;

  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={disabled}>
      {running ? (
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      ) : (
        <Plus className="mr-1 h-3 w-3" />
      )}
      {running && progress ? `생성 중 (${progress.done}/${progress.total})` : `${label} (${pending}건)`}
    </Button>
  );
}
