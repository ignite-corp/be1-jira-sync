// 동기화 관련 타입 정의

// 동기화 대상 프로젝트
export type SyncTargetProject = 'KQ' | 'HDD' | 'HB' | 'AUTOWAY';

// 동기화 모드
export type SyncMode =
  | '전체'
  | `${string} -> ${SyncTargetProject}`
  | '에픽 지정'
  | '티켓 지정';

// 동기화 결과
export interface SyncResult {
  fehgKey: string;
  targetKey: string;
  targetProject: SyncTargetProject;
  success: boolean;
  message?: string;
  error?: string;
  isNewlyCreated?: boolean; // 신규 생성 여부
}

// 동기화 요약
export interface SyncSummary {
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
  totalUpdated: number; // 필드 동기화 (업데이트)
  totalCreated: number; // 신규 생성
  results: SyncResult[];
  failedResults: SyncResult[];
}

// 로그 타입
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface SyncLog {
  timestamp: string;
  level: LogLevel;
  message: string;
}

// 스프린트 정보
export interface SprintInfo {
  id: number;
  name: string;
  state: 'active' | 'future' | 'closed';
  boardId: number;
}

// 동기화 옵션
export interface SyncOptions {
  assigneeAccountId?: string; // 담당자 Ignite accountId (에픽 단위 동기화 시 생략 가능)
  assigneeName?: string; // 담당자 이름 (로깅용)
  teamUsers?: { name: string; igniteAccountId: string; hmgAccountId: string; hmgUserId: string }[]; // 같은 팀 사용자 목록 (계정 매핑용)
  targetProjects?: SyncTargetProject[]; // 대상 프로젝트 (없으면 전체)
  epicId?: string; // 에픽 지정 모드
  ticketId?: string; // 티켓 지정 모드
  syncAllInEpic?: boolean; // 에픽 단위 동기화 (담당자 무관하게 에픽 하위 전체 동기화)
  syncProfileId?: string; // DB 기반 동기화 시 사용할 프로필 ID
  chunkSize?: number; // 청크 크기 (기본: 15)
}
