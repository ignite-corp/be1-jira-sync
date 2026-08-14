'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Home, Download, Plus } from 'lucide-react';

// Mermaid 타입 정의
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mermaid?: any;
  }
}

export default function FlowChartPage() {
  const [activeTab, setActiveTab] = useState<number>(1);
  const mermaidRef = useRef<HTMLDivElement>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [svgContent, setSvgContent] = useState<string>('');

  // Mermaid 초기화
  useEffect(() => {
    const loadMermaid = async () => {
      if (typeof window !== 'undefined') {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          flowchart: {
            curve: 'basis',
            padding: 20,
          },
          themeVariables: {
            primaryColor: '#3b82f6',
            primaryTextColor: '#fff',
            primaryBorderColor: '#2563eb',
            lineColor: '#64748b',
            secondaryColor: '#10b981',
            tertiaryColor: '#ef4444',
            fontSize: '14px',
          },
        });
        window.mermaid = mermaid;
        setIsLoaded(true);
      }
    };

    loadMermaid();
  }, []);

  const flowCharts = [
    {
      id: 1,
      title: '1. 전체 동기화 플로우',
      description: '담당자 선택 → 전체 → 동기화 버튼',
      diagram: `
flowchart TD
    Start([사용자: 담당자 선택]) --> SelectType[동기화 타입: 전체 선택]
    SelectType --> ClickBtn[동기화 버튼 클릭]
    
    ClickBtn --> Validate{검증}
    Validate -->|실패| ErrorToast[Toast 에러 표시]
    ErrorToast --> End([종료])
    
    Validate -->|성공| HandleSync[handleSync 실행]
    HandleSync --> CreateOrch[SyncOrchestrator 생성<br/>+ 로그 콜백 설정]
    
    CreateOrch --> Execute[orchestrator.execute]
    
    Execute --> InitCache[스프린트 캐시 초기화]
    InitCache --> DetermineProj[대상 프로젝트 결정<br/>→ KQ, HDD, HB, AUTOWAY]
    
    DetermineProj --> PreloadSprint{스프린트 프리로드}
    
    PreloadSprint -.병렬.-> LoadKQ[KQ 스프린트 조회]
    PreloadSprint -.병렬.-> LoadHDD[HDD 스프린트 조회]
    PreloadSprint -.병렬.-> LoadHB[HB 스프린트 조회]
    
    LoadKQ --> SprintDone[프리로드 완료]
    LoadHDD --> SprintDone
    LoadHB --> SprintDone
    
    SprintDone --> FetchFEHG[FEHG 티켓 조회<br/>JQL: project = FEHG AND assignee = ...]
    
    FetchFEHG --> CheckTickets{티켓 존재?}
    CheckTickets -->|없음| Warning[경고 로그 + 종료]
    Warning --> Summary
    
    CheckTickets -->|있음| Classify[티켓 분류 1회 순회<br/>→ issuelinks 확인<br/>→ customfield_10438 확인]
    
    Classify --> ClassifyResult{프로젝트별 분류 완료}
    
    ClassifyResult --> ProjectSync[프로젝트별 순차 동기화]
    
    ProjectSync --> SyncKQ[KQ 동기화<br/>청크 단위 병렬 처리]
    SyncKQ --> SyncHDD[HDD 동기화<br/>청크 단위 병렬 처리]
    SyncHDD --> SyncHB[HB 동기화<br/>청크 단위 병렬 처리]
    SyncHB --> SyncAW[AUTOWAY 동기화<br/>청크 단위 병렬 처리]
    
    SyncAW --> AllComplete[모든 프로젝트 완료]
    AllComplete --> Summary[결과 요약 생성]
    
    Summary --> CalcStats[통계 계산<br/>• 총 처리<br/>• 성공/실패<br/>• 신규 생성/업데이트]
    
    CalcStats --> UIUpdate[UI 업데이트<br/>• 로그 표시<br/>• 링크 생성<br/>• Toast 알림]
    
    UIUpdate --> End
    
    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style ErrorToast fill:#ef4444,color:#fff
    style Warning fill:#f59e0b,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style PreloadSprint fill:#ec4899,color:#fff
    style ProjectSync fill:#8b5cf6,color:#fff
    style SyncKQ fill:#ec4899,color:#fff
    style SyncHDD fill:#ec4899,color:#fff
    style SyncHB fill:#ec4899,color:#fff
    style SyncAW fill:#ec4899,color:#fff
    style Summary fill:#10b981,color:#fff
`,
    },
    {
      id: 2,
      title: '2-1. Ignite 프로젝트 동기화 (KQ/HB/HDD)',
      description: 'FEHG → KQ/HB/HDD 동기화 상세 플로우',
      diagram: `
flowchart TD
    Start([담당자 선택<br/>예: 홍길동])
    Start --> GetUser[사용자 정보 조회<br/>DB users 테이블]
    GetUser --> UserInfo[igniteAccountId 추출<br/>61234...abcd]
    
    UserInfo --> SelectType[FEHG to KQ 선택]
    SelectType --> ClickBtn[동기화 버튼]
    
    ClickBtn --> Execute[orchestrator.execute]
    Execute --> PreloadSprint[스프린트 캐싱<br/>BOARD_IDS KQ 보드 조회]
    
    PreloadSprint --> SprintCache[캐시 저장<br/>Map boardId to SprintInfo]
    SprintCache --> FetchFEHG[FEHG 티켓 조회]
    
    FetchFEHG --> Classify[issuelinks 확인<br/>Blocks 관계 찾기]
    Classify --> FindLinked[KQ- prefix 티켓 찾기]
    
    FindLinked --> SyncKQ[IgniteSyncService.syncTicket]
    SyncKQ --> MapFields[필드 매핑]
    
    MapFields --> Field1[summary 복사]
    Field1 --> Field2[duedate 복사]
    Field2 --> Field3[시작일 customfield_10015]
    Field3 --> Field4[assignee accountId 동일]
    Field4 --> Field5[timetracking 복사]
    
    Field5 --> SprintMap[스프린트 매핑]
    SprintMap --> ExtractPeriod[FEHG 2511 추출<br/>기간: 2511]
    ExtractPeriod --> ConvertYear[202511로 변환]
    ConvertYear --> BuildTarget[KQ 202511 생성]
    BuildTarget --> FindSprint[캐시에서 스프린트 조회<br/>이름 매칭]
    FindSprint --> SprintID[스프린트 ID 반환]
    
    SprintID --> UpdateFields[jira.ignite.updateIssueFields<br/>PUT /rest/api/3/issue/KQ-XXX]
    UpdateFields --> StatusSync[상태 동기화<br/>HDD는 스킵]
    
    StatusSync --> MapStatus[STATUS_MAPPING.IGNITE<br/>fehgStatusId to transitionId]
    MapStatus --> Transition[jira.ignite.updateIssueStatus<br/>POST /rest/api/3/issue/KQ-XXX/transitions]
    
    Transition --> Complete[동기화 완료]
    Complete --> End([종료])
    
    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style SprintCache fill:#f59e0b,color:#fff
    style MapFields fill:#ec4899,color:#fff
    style SprintMap fill:#f59e0b,color:#fff
    style UpdateFields fill:#10b981,color:#fff
    style Transition fill:#10b981,color:#fff
`,
    },
    {
      id: 3,
      title: '2-2. HMG 프로젝트 동기화 (AUTOWAY)',
      description: 'FEHG → AUTOWAY 동기화 상세 플로우',
      diagram: `
flowchart TD
    Start([담당자 선택<br/>예: 홍길동])
    Start --> GetUser[사용자 정보 조회<br/>DB users 테이블]
    GetUser --> UserInfo[igniteAccountId<br/>hmgAccountId 추출]
    
    UserInfo --> SelectAW[FEHG to AUTOWAY 선택]
    SelectAW --> ClickBtn[동기화 버튼]
    
    ClickBtn --> Execute[HMGSyncService.syncTicket]
    Execute --> CheckField[customfield_10438 확인]
    
    CheckField --> HasLink{AUTOWAY 링크<br/>존재?}
    
    HasLink -->|없음| CreateFlow[신규 생성 플로우]
    CreateFlow --> MapCreate[필드 매핑]
    
    MapCreate --> C1[summary 복사]
    C1 --> C2[description ADF 생성<br/>FEHG 링크 포함]
    C2 --> C3[duedate 3개 필드<br/>duedate, End Date, Gantt End]
    C3 --> C4[시작일 3개 필드<br/>Start Date x2, Gantt Start]
    C4 --> C5[assignee 매핑<br/>ignite to hmg accountId]
    C5 --> C6[reporter 매핑<br/>ignite to hmg accountId]
    
    C6 --> CreateTicket[jira.hmg.createIssue<br/>POST /rest/api/3/issue]
    CreateTicket --> GetKey[AUTOWAY-XXX 생성]
    GetKey --> SaveLink[FEHG customfield_10438 저장<br/>AUTOWAY URL]
    SaveLink --> CreateStatus[상태 동기화]
    
    HasLink -->|있음| UpdateFlow[기존 티켓 업데이트 플로우]
    UpdateFlow --> ExtractKey[AUTOWAY-XXX 추출<br/>정규식 매칭]
    ExtractKey --> MapUpdate[필드 매핑<br/>생성과 동일]
    
    MapUpdate --> UpdateTicket[jira.hmg.updateIssue<br/>PUT /rest/api/3/issue/AUTOWAY-XXX]
    UpdateTicket --> UpdateStatus[상태 동기화]
    
    CreateStatus --> MapHMG[STATUS_MAPPING.HMG<br/>fehgStatusId to transitionId]
    UpdateStatus --> MapHMG
    
    MapHMG --> TransitionAW[jira.hmg.updateIssueStatus<br/>POST transitions]
    TransitionAW --> Complete[동기화 완료]
    Complete --> End([종료])
    
    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style CheckField fill:#8b5cf6,color:#fff
    style CreateFlow fill:#ec4899,color:#fff
    style UpdateFlow fill:#06b6d4,color:#fff
    style CreateTicket fill:#10b981,color:#fff
    style SaveLink fill:#f59e0b,color:#fff
    style MapHMG fill:#f59e0b,color:#fff
    style TransitionAW fill:#10b981,color:#fff
`,
    },
    {
      id: 4,
      title: '3. 에픽 지정 동기화',
      description: '담당자 선택 → 에픽 지정 → FEHG-123 입력 → 동기화 버튼',
      diagram: `
flowchart TD
    Start([담당자 선택])
    Start --> InputEpic[에픽 번호 입력]
    InputEpic --> ClickBtn[동기화 버튼]
    
    ClickBtn --> HandleSync[handleSync]
    HandleSync --> Execute[execute]
    Execute --> DetermineEpic[에픽 대상 결정]
    
    DetermineEpic --> FetchEpic[에픽 조회]
    FetchEpic --> FetchTickets[하위 티켓 조회]
    FetchTickets --> Classify[티켓 분류]
    
    Classify --> SyncLoop[프로젝트별 동기화]
    SyncLoop --> Summary[결과 요약]
    Summary --> End([종료])
    
    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style SyncLoop fill:#ec4899,color:#fff
    style Summary fill:#10b981,color:#fff
`,
    },
    {
      id: 5,
      title: '4. 티켓 지정 동기화',
      description: '담당자 선택 → 티켓 지정 → FEHG-456 입력 → 동기화 버튼',
      diagram: `
flowchart TD
    Start([담당자 선택])
    Start --> InputTicket[티켓 번호 입력]
    InputTicket --> ClickBtn[동기화 버튼]
    
    ClickBtn --> HandleSync[handleSync]
    HandleSync --> Execute[execute]
    Execute --> DetermineTicket[티켓 대상 결정]
    
    DetermineTicket --> FetchTicket[티켓 조회]
    FetchTicket --> CheckLinks[issuelinks 확인]
    CheckLinks --> SyncSingle[동기화 실행]
    
    SyncSingle --> Summary[결과 요약]
    Summary --> End([종료])
    
    style Start fill:#3b82f6,color:#fff
    style End fill:#10b981,color:#fff
    style Execute fill:#8b5cf6,color:#fff
    style SyncSingle fill:#ec4899,color:#fff
    style Summary fill:#10b981,color:#fff
`,
    },
  ];

  const currentChart = flowCharts.find((chart) => chart.id === activeTab);

  // 탭 변경 시 Mermaid 다시 렌더링
  useEffect(() => {
    const renderDiagram = async () => {
      const chart = flowCharts.find((c) => c.id === activeTab);
      if (isLoaded && window.mermaid && chart) {
        try {
          // 타임아웃 설정 (10초)
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Rendering timeout')), 10000);
          });

          const uniqueId = `mermaid-${activeTab}-${Date.now()}`;
          const renderPromise = window.mermaid.render(uniqueId, chart.diagram);

          const { svg } = (await Promise.race([
            renderPromise,
            timeoutPromise,
          ])) as { svg: string };
          setSvgContent(svg);
        } catch (error) {
          console.error(`❌ Chart ${activeTab} rendering error:`, error);
          console.error('Diagram content:', chart.diagram.substring(0, 200));
          setSvgContent(
            '<div style="padding:20px;color:red;text-align:center;">차트 렌더링 실패. 콘솔을 확인하세요.</div>'
          );
        }
      }
    };

    renderDiagram();
    // flowCharts는 정적 배열이므로 의존성 불필요
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isLoaded]);

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">티켓 동기화 Flow Chart</h1>
            <p className="text-sm text-muted-foreground">
              자동화 작업의 전체 흐름을 시각화합니다
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/create-epic">
              <Button variant="outline">
                <Plus className="mr-2 h-4 w-4" />
                에픽 생성
              </Button>
            </Link>
            <Link href="/">
              <Button variant="outline">
                <Home className="mr-2 h-4 w-4" />
                홈으로
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-8">
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {flowCharts.map((chart) => (
            <Button
              key={chart.id}
              variant={activeTab === chart.id ? 'default' : 'outline'}
              onClick={() => setActiveTab(chart.id)}
              className="whitespace-nowrap"
            >
              {chart.title}
            </Button>
          ))}
        </div>

        {/* Chart Card */}
        {currentChart && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{currentChart.title}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {currentChart.description}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const svg = mermaidRef.current?.querySelector('svg');
                    if (svg) {
                      const svgData = new XMLSerializer().serializeToString(
                        svg
                      );
                      const blob = new Blob([svgData], {
                        type: 'image/svg+xml',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `flow-chart-${currentChart.id}.svg`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  SVG 다운로드
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div
                ref={mermaidRef}
                className="overflow-x-auto bg-white rounded-lg p-6"
                dangerouslySetInnerHTML={{ __html: svgContent }}
              />

              {/* 범례 */}
              <div className="mt-6 p-4 bg-muted rounded-lg">
                <h3 className="font-semibold mb-3">범례</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-blue-500 rounded"></div>
                    <span>시작/주요 단계</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-green-500 rounded"></div>
                    <span>성공/완료</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-red-500 rounded"></div>
                    <span>에러/실패</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-pink-500 rounded"></div>
                    <span>병렬 처리</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-purple-500 rounded"></div>
                    <span>핵심 로직</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 bg-yellow-500 rounded"></div>
                    <span>경고</span>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t">
                  <p className="text-xs text-muted-foreground">
                    • 실선 화살표: 순차 실행 | 점선 화살표: 병렬 실행 또는 내부
                    처리
                  </p>
                  <p className="text-xs text-muted-foreground">
                    • 다이아몬드 &#9830;: 조건 분기 | 둥근 사각형: 프로세스
                  </p>
                </div>
              </div>

              {/* 주요 포인트 설명 */}
              <div className="mt-6 space-y-4">
                {activeTab === 1 && (
                  <>
                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 병렬 처리 구간
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • <strong>스프린트 프리로드</strong>: KQ, HDD, HB의
                          스프린트 정보를 동시에 조회
                        </li>
                        <li>
                          • <strong>청크 내부 병렬 처리</strong>: 각
                          프로젝트에서 15개씩 묶어 동시 처리
                          (Promise.allSettled)
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-red-50 border-l-4 border-red-500 rounded">
                      <h4 className="font-semibold text-red-900 mb-2">
                        🔴 에러 처리
                      </h4>
                      <ul className="text-sm text-red-800 space-y-1">
                        <li>
                          • <strong>검증 단계</strong>: 담당자 미선택 시 즉시
                          종료
                        </li>
                        <li>
                          • <strong>Promise.allSettled</strong>: 일부 티켓
                          실패해도 나머지 계속 진행
                        </li>
                        <li>
                          • <strong>결과 요약</strong>: 성공/실패 구분하여 통계
                          제공
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 최적화 포인트
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>
                          • <strong>스프린트 캐싱</strong>: 동기화 세션 동안
                          스프린트 목록 재사용
                        </li>
                        <li>
                          • <strong>1회 순회 분류</strong>: 티켓을 한 번만
                          순회하여 프로젝트별 분류
                        </li>
                        <li>
                          • <strong>청킹 전략</strong>: API 부하 방지를 위해
                          15개씩 나눠서 처리
                        </li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 2 && (
                  <>
                    <div className="p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded">
                      <h4 className="font-semibold text-yellow-900 mb-2">
                        🟡 담당자 매핑
                      </h4>
                      <ul className="text-sm text-yellow-800 space-y-1">
                        <li>
                          • UI에서 선택한 담당자 이름 → DB users 테이블로 조회
                        </li>
                        <li>
                          • igniteAccountId 추출 (Ignite 프로젝트는 동일 ID
                          사용)
                        </li>
                        <li>• assignee 필드에 accountId 객체로 전달</li>
                      </ul>
                    </div>

                    <div className="p-4 bg-orange-50 border-l-4 border-orange-500 rounded">
                      <h4 className="font-semibold text-orange-900 mb-2">
                        🟠 스프린트 캐싱 & 매핑
                      </h4>
                      <ul className="text-sm text-orange-800 space-y-1">
                        <li>
                          • <strong>캐싱</strong>: 동기화 시작 시
                          Map&lt;boardId, SprintInfo[]&gt; 생성
                        </li>
                        <li>
                          • <strong>매핑</strong>: &quot;FEHG 2511&quot; →
                          &quot;KQ 202511&quot; 이름 변환 후 ID 조회
                        </li>
                        <li>
                          • <strong>성능</strong>: 한 번만 조회하고 재사용
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 업데이트 필드
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>• summary, duedate, customfield_10015 (시작일)</li>
                        <li>• assignee, timetracking</li>
                        <li>• customfield_10020 (스프린트)</li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 Transition API
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>• STATUS_MAPPING.IGNITE로 transitionId 조회</li>
                        <li>• POST /rest/api/3/issue/KQ-XXX/transitions</li>
                        <li>• HDD 프로젝트는 권한 문제로 상태 동기화 스킵</li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 3 && (
                  <>
                    <div className="p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded">
                      <h4 className="font-semibold text-yellow-900 mb-2">
                        🟡 담당자 매핑 (Cross-Platform)
                      </h4>
                      <ul className="text-sm text-yellow-800 space-y-1">
                        <li>
                          • igniteAccountId (FEHG 조회용) → hmgAccountId
                          (AUTOWAY 설정용)
                        </li>
                        <li>• DB users 테이블에서 두 ID 모두 보관</li>
                        <li>• assignee와 reporter 모두 hmgAccountId로 설정</li>
                      </ul>
                    </div>

                    <div className="p-4 bg-purple-50 border-l-4 border-purple-500 rounded">
                      <h4 className="font-semibold text-purple-900 mb-2">
                        🟣 customfield_10438 핵심 로직
                      </h4>
                      <ul className="text-sm text-purple-800 space-y-1">
                        <li>
                          • <strong>비어있음</strong>: AUTOWAY 티켓 신규 생성 후
                          URL 저장
                        </li>
                        <li>
                          • <strong>AUTOWAY 링크 있음</strong>: 정규식으로 키
                          추출 후 업데이트
                        </li>
                        <li>
                          • <strong>저장 형식</strong>:
                          https://hmg.atlassian.net/browse/AUTOWAY-XXX
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 업데이트 필드 (AUTOWAY 전용)
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>• summary, description (ADF 형식)</li>
                        <li>
                          • duedate, customfield_10063 (End Date),
                          customfield_10067 (Gantt End)
                        </li>
                        <li>
                          • customfield_10064 (Start Date), customfield_10065,
                          customfield_10066 (Gantt Start)
                        </li>
                        <li>• assignee, reporter (hmg accountId로 변환)</li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 Transition API (HMG)
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>• STATUS_MAPPING.HMG로 transitionId 조회</li>
                        <li>
                          • POST /rest/api/3/issue/AUTOWAY-XXX/transitions
                        </li>
                        <li>• 신규 생성 후에도 상태 동기화 수행</li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 4 && (
                  <>
                    <div className="p-4 bg-purple-50 border-l-4 border-purple-500 rounded">
                      <h4 className="font-semibold text-purple-900 mb-2">
                        🟣 에픽 기반 대상 결정
                      </h4>
                      <ul className="text-sm text-purple-800 space-y-1">
                        <li>
                          • <strong>Summary 분석</strong>: 에픽 제목에 [KQ],
                          [HB], [HDD] 포함 여부로 대상 결정
                        </li>
                        <li>
                          • <strong>자동 판단</strong>: prefix 없으면 KQ, HB,
                          HDD 모두 동기화
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 에픽 하위 티켓만 처리
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • JQL: &quot;Epic Link&quot; = FEHG-123 AND assignee =
                          ...
                        </li>
                        <li>• 에픽에 속한 티켓만 선별적으로 동기화</li>
                        <li>
                          • 에픽 단위 통계 제공 (신규 생성, 업데이트, 실패)
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 사용 사례
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>• 특정 에픽(기능 단위) 전체를 동기화할 때</li>
                        <li>
                          • 신규 에픽을 생성하고 하위 티켓을 일괄 동기화할 때
                        </li>
                        <li>• AUTOWAY 전용 에픽의 티켓들을 동기화할 때</li>
                      </ul>
                    </div>
                  </>
                )}

                {activeTab === 5 && (
                  <>
                    <div className="p-4 bg-cyan-50 border-l-4 border-cyan-500 rounded">
                      <h4 className="font-semibold text-cyan-900 mb-2">
                        🔷 3단계 대상 결정 로직
                      </h4>
                      <ul className="text-sm text-cyan-800 space-y-1">
                        <li>
                          • <strong>1단계</strong>: issuelinks에서 Blocks 관계
                          확인 (KQ/HB/HDD)
                        </li>
                        <li>
                          • <strong>2단계</strong>: customfield_10438에 AUTOWAY
                          링크 확인
                        </li>
                        <li>
                          • <strong>3단계</strong>: 상위 에픽이 허용 목록에
                          있는지 확인
                        </li>
                        <li>
                          • 모두 해당 없으면 &quot;동기화 대상 아님&quot; 경고
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-blue-50 border-l-4 border-blue-500 rounded">
                      <h4 className="font-semibold text-blue-900 mb-2">
                        🔵 단일 티켓 처리
                      </h4>
                      <ul className="text-sm text-blue-800 space-y-1">
                        <li>
                          • <strong>청크 불필요</strong>: 1개 티켓만 처리하므로
                          즉시 동기화
                        </li>
                        <li>
                          • <strong>빠른 응답</strong>: 불필요한 대기 시간 없이
                          즉시 결과 확인
                        </li>
                        <li>
                          • <strong>디버깅 용이</strong>: 특정 티켓의 동기화
                          문제 추적에 최적
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 bg-green-50 border-l-4 border-green-500 rounded">
                      <h4 className="font-semibold text-green-900 mb-2">
                        🟢 사용 사례
                      </h4>
                      <ul className="text-sm text-green-800 space-y-1">
                        <li>• 특정 티켓의 동기화가 실패했을 때 재시도</li>
                        <li>• 신규 티켓을 생성 직후 즉시 동기화할 때</li>
                        <li>• 동기화 로직 테스트 및 검증 목적</li>
                      </ul>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
