/**
 * 양방향 동기화 비교 로직 단위 검증 (BEDEV1-529)
 *
 * 사용법:
 *   npx tsx scripts/verify-comparator.ts
 *
 * 목적: "같은 논리적 내용이 두 사이트에서 다르게 표현돼도 같다고 판정되는가" 를 증명한다.
 * JIRA 자격증명 없이 도는 순수 함수 검증이라 CI/로컬 어디서나 재현 가능하다.
 *
 * 입력 데이터는 실제 ignitecorp JIRA 응답에서 가져온 모양을 그대로 쓴다
 * (BEDEV1 202608 스프린트 id 3649, boardId 449, KQ-18184 ↔ BEDEV1-531 Blocks 링크 등).
 */

import type { JiraIssue } from '@/lib/types/jira';
import type { DbFieldMapping } from '@/lib/services/sync/db-field-mapper';
import { compareMappedFields, suggestDirection } from '@/lib/services/sync/ticket-comparator';
import {
  canonicalizeFieldValue,
  parseJiraDuration,
  adfToPlainText,
} from '@/lib/services/sync/field-canonicalizer';
import {
  findBlocksOutwardKeys,
  findLinkedSourceKeys,
  extractLinkFieldKeys,
} from '@/lib/services/sync/link-resolver';
import { chooseCreateIssueType } from '@/lib/services/sync/issue-type-resolver';
import { sanitizeWritePayload } from '@/lib/services/sync/write-payload';
import { hasProjectLabel, withProjectLabel } from '@/lib/services/sync/project-label';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.warn(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        기대: ${JSON.stringify(expected)}`);
    console.error(`        실제: ${JSON.stringify(actual)}`);
  }
}

function section(title: string) {
  console.warn(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// 테스트용 매핑 (sync_field_mappings 행 모양 그대로)
// ---------------------------------------------------------------------------

const MAPPINGS: DbFieldMapping[] = [
  {
    source_field: 'summary',
    source_field_name: '요약',
    target_field: 'summary',
    target_field_name: '요약',
    transform_type: 'copy',
    transform_config: null,
  },
  {
    source_field: 'description',
    source_field_name: '설명',
    target_field: 'description',
    target_field_name: '설명',
    transform_type: 'copy',
    transform_config: null,
  },
  {
    source_field: 'assignee',
    source_field_name: '담당자',
    target_field: 'assignee',
    target_field_name: '담당자',
    transform_type: 'copy',
    transform_config: null,
  },
  {
    source_field: 'duedate',
    source_field_name: '종료일',
    target_field: 'duedate',
    target_field_name: '종료일',
    transform_type: 'copy',
    transform_config: null,
  },
  {
    source_field: 'timetracking',
    source_field_name: '작업시간',
    target_field: 'timetracking',
    target_field_name: '작업시간',
    transform_type: 'copy',
    transform_config: null,
  },
  {
    source_field: 'fixVersions',
    source_field_name: '수정버전',
    target_field: 'fixVersions',
    target_field_name: '수정버전',
    transform_type: 'version_map',
    transform_config: null,
  },
  {
    // 소스(BEDEV1)와 대상(AUTOWAY)의 스프린트 필드 id 가 다른 상황을 재현
    source_field: 'customfield_10020',
    source_field_name: '스프린트',
    target_field: 'customfield_10111',
    target_field_name: '스프린트',
    transform_type: 'sprint_map',
    transform_config: null,
  },
];

function targetTicket(fields: Record<string, unknown>): JiraIssue {
  return {
    id: '99999',
    key: 'AUTOWAY-4371',
    self: '',
    fields: {
      summary: '',
      issuetype: { id: '1', name: '작업', description: '', iconUrl: '', subtask: false },
      project: {} as JiraIssue['fields']['project'],
      status: {} as JiraIssue['fields']['status'],
      created: '',
      updated: '',
      ...fields,
    } as JiraIssue['fields'],
  };
}

// ---------------------------------------------------------------------------
// 1. 동기화 직후 상황: 매핑 결과 그대로 쓰인 대상 → diff 가 비어야 한다
// ---------------------------------------------------------------------------

section('1. 동기화 직후에는 diff 가 비어야 한다 (결정 2 의 전제)');

// mapFieldsFromDb() 가 만들어내는 "쓰기 페이로드" 모양
const mappedFields: Record<string, unknown> = {
  summary: '[BE][그룹웨어][게시판] 첨부파일 S3 에 없는 경우 AccessDenied Error handling',
  description: {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '연관 링크' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'signedUrl 생성 시 파일 없는 경우 오류 처리' }] },
    ],
  },
  assignee: { accountId: '712020:hmg-account-id' },
  duedate: '2026-08-29',
  timetracking: { originalEstimate: '1d', remainingEstimate: '4h' },
  fixVersions: [{ id: '10501' }, { id: '10502' }],
  customfield_10111: 987,
};

// 위 페이로드가 반영된 뒤 Jira 가 돌려주는 "읽기" 모양
const afterWrite = targetTicket({
  summary: '[BE][그룹웨어][게시판] 첨부파일 S3 에 없는 경우 AccessDenied Error handling',
  description: {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '연관 링크' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'signedUrl 생성 시 파일 없는 경우 오류 처리' }] },
    ],
  },
  assignee: {
    accountId: '712020:hmg-account-id',
    displayName: '홍길동',
    emailAddress: 'user1@example.com',
    avatarUrls: {},
  },
  duedate: '2026-08-29',
  timetracking: {
    originalEstimate: '1d',
    remainingEstimate: '4h',
    timeSpent: '2h',
    originalEstimateSeconds: 28800,
    remainingEstimateSeconds: 14400,
    timeSpentSeconds: 7200,
  },
  fixVersions: [
    { id: '10502', name: '2026.09', archived: false, released: false },
    { id: '10501', name: '2026.08', archived: false, released: false },
  ],
  customfield_10111: [
    { id: 987, name: 'GW 202608', state: 'active', boardId: 521 },
  ],
});

const afterSync = compareMappedFields(MAPPINGS, mappedFields, afterWrite.fields);
check('동기화 직후 diff 없음 (identical)', afterSync.identical, true);
check('동기화 직후 변경 필드 0개', afterSync.changed.length, 0);
check('비교한 필드 7개', afterSync.fields.length, 7);

// ---------------------------------------------------------------------------
// 2. 표현만 다르고 내용이 같은 경우 → 같다고 판정돼야 한다
// ---------------------------------------------------------------------------

section('2. 표현이 달라도 같은 내용이면 같다고 판정');

check(
  '작업시간: "1d" 와 "8h" 는 같다',
  parseJiraDuration('1d') === parseJiraDuration('8h'),
  true
);
check('작업시간: "1w" = 5d = 144000초', parseJiraDuration('1w'), 144000);
check('작업시간: "1d 2h 30m" = 37800초', parseJiraDuration('1d 2h 30m'), 37800);

check(
  '작업시간: 초 정보가 있는 쪽/없는 쪽이 같다고 판정',
  canonicalizeFieldValue('timetracking', { originalEstimate: '1d' }).canonical ===
    canonicalizeFieldValue('timetracking', {
      originalEstimate: '8h',
      originalEstimateSeconds: 28800,
      timeSpent: '3h',
    }).canonical,
  true
);

check(
  '담당자: {accountId} 와 조회 응답 객체가 같다고 판정',
  canonicalizeFieldValue('user', { accountId: 'abc' }).canonical ===
    canonicalizeFieldValue('user', {
      accountId: 'abc',
      displayName: '김철수',
      emailAddress: 'user2@example.com',
    }).canonical,
  true
);

check(
  '스프린트: 숫자 id 와 조회 배열이 같다고 판정',
  canonicalizeFieldValue('sprint', 3649).canonical ===
    canonicalizeFieldValue('sprint', [
      { id: 3649, name: 'BEDEV1 202608', state: 'active', boardId: 449 },
    ]).canonical,
  true
);

check(
  '스프린트: 닫힌 스프린트가 섞여 있어도 active 를 고른다',
  canonicalizeFieldValue('sprint', [
    { id: 3649, name: 'BEDEV1 202608', state: 'active', boardId: 449 },
    { id: 3451, name: 'BEDEV1 202607', state: 'closed', boardId: 449 },
  ]).canonical,
  '3649'
);

check(
  '수정버전: 순서가 달라도 같다고 판정',
  canonicalizeFieldValue('versions', [{ id: '10501' }, { id: '10502' }]).canonical ===
    canonicalizeFieldValue('versions', [
      { id: '10502', name: '2026.09' },
      { id: '10501', name: '2026.08' },
    ]).canonical,
  true
);

check(
  '본문: ADF 의 media 노드는 무시된다 (첨부 때문에 매번 다르다고 나오면 안 됨)',
  canonicalizeFieldValue('adf', {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '오류 처리' }] },
      {
        type: 'mediaSingle',
        content: [{ type: 'media', attrs: { id: 'uuid-only-on-source', type: 'file' } }],
      },
    ],
  }).canonical ===
    canonicalizeFieldValue('adf', {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '오류 처리' }] }],
    }).canonical,
  true
);

check(
  '본문: 공백/빈 줄 차이는 무시된다',
  canonicalizeFieldValue('adf', {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '  오류   처리  ' }] },
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [{ type: 'text', text: '끝' }] },
    ],
  }).canonical,
  '오류 처리\n끝'
);

check(
  '본문: ADF 와 같은 내용의 평문 문자열이 같다고 판정',
  canonicalizeFieldValue('adf', {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '오류 처리' }] }],
  }).canonical === canonicalizeFieldValue('adf', '오류 처리').canonical,
  true
);

check(
  'ADF 평문화: 중첩 리스트도 텍스트가 살아난다',
  adfToPlainText({
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '항목1' }] }],
          },
        ],
      },
    ],
  }).includes('항목1'),
  true
);

// ---------------------------------------------------------------------------
// 3. 진짜 다른 경우 → 다르다고 판정돼야 한다
// ---------------------------------------------------------------------------

section('3. 내용이 실제로 다르면 다르다고 판정');

const changedTarget = targetTicket({
  ...afterWrite.fields,
  summary: '누군가 대상에서 제목을 바꿨다',
  duedate: '2026-09-10',
});

const changedResult = compareMappedFields(MAPPINGS, mappedFields, changedTarget.fields);
check('변경 감지: identical=false', changedResult.identical, false);
check('변경 감지: 2개 필드가 다름', changedResult.changed.length, 2);
check(
  '변경 감지: 어떤 필드인지 정확히 짚는다',
  changedResult.changed.map((d) => d.targetField).sort(),
  ['duedate', 'summary']
);
check(
  '변경 감지: 양쪽 값이 표시된다',
  changedResult.changed.find((d) => d.targetField === 'duedate')?.targetDisplay,
  '2026-09-10'
);

check(
  '스프린트가 다르면 다르다고 판정',
  compareMappedFields(
    MAPPINGS,
    mappedFields,
    targetTicket({
      ...afterWrite.fields,
      customfield_10111: [{ id: 900, name: 'GW 202607', state: 'closed', boardId: 521 }],
    }).fields
  ).changed.map((d) => d.targetField),
  ['customfield_10111']
);

// ---------------------------------------------------------------------------
// 4. 거짓 diff 방지: 소스에 값이 없는 필드는 비교하지 않는다
// ---------------------------------------------------------------------------

section('4. 빈 값 처리');

const sparseMapped: Record<string, unknown> = {
  summary: '요약만 있는 소스',
  // description/assignee/duedate/timetracking/fixVersions/sprint 없음
};

// 양쪽 다 비어 있는 필드는 비교 대상이 아니다
const bothEmpty = compareMappedFields(
  MAPPINGS,
  sparseMapped,
  targetTicket({ summary: '요약만 있는 소스' }).fields
);
check('양쪽 다 비어 있으면 비교 대상에서 빠진다', bothEmpty.fields.length, 1);
check('양쪽 다 비어 있으면 diff 없음', bothEmpty.identical, true);

// 한쪽에만 값이 있으면 실제 차이다 (양방향에서 반대쪽으로 가져와야 하는 값)
const targetOnly = targetTicket({
  summary: '요약만 있는 소스',
  timetracking: {
    originalEstimate: '2d',
    originalEstimateSeconds: 57600,
  },
});
const targetOnlyResult = compareMappedFields(MAPPINGS, sparseMapped, targetOnly.fields);
check(
  '대상에만 추정치가 있으면 diff 로 잡힌다 (BEDEV1-529 ↔ KQ-18190 회귀)',
  targetOnlyResult.changed.map((d) => d.targetField),
  ['timetracking']
);
check('대상에만 값이 있으면 identical=false', targetOnlyResult.identical, false);
check(
  '빈 쪽은 "(없음)" 으로 표시된다',
  targetOnlyResult.changed[0]?.sourceDisplay,
  '(없음)'
);

// 반대 방향(소스에만 값이 있는 경우)도 잡힌다
const sourceOnlyResult = compareMappedFields(
  MAPPINGS,
  { summary: 'x', duedate: '2026-08-29' },
  targetTicket({ summary: 'x' }).fields
);
check(
  '소스에만 값이 있어도 diff 로 잡힌다',
  sourceOnlyResult.changed.map((d) => d.targetField),
  ['duedate']
);

check(
  '매핑이 비어 있으면 비교할 것이 없다',
  compareMappedFields([], mappedFields, afterWrite.fields).identical,
  true
);

// ---------------------------------------------------------------------------
// 5. 방향 힌트 (결정 2: 판정이 아니라 힌트로만)
// ---------------------------------------------------------------------------

section('5. 방향 힌트');

check(
  '대상이 더 최근이면 대상 → 소스 제안',
  suggestDirection('2026-08-13T02:00:00.000+0000', '2026-08-13T06:00:00.000+0000'),
  'targetToSource'
);
check(
  '소스가 더 최근이면 소스 → 대상 제안',
  suggestDirection('2026-08-13T06:00:00.000+0000', '2026-08-13T02:00:00.000+0000'),
  'sourceToTarget'
);
check('시각이 같으면 기존 동작(소스 기준) 유지', suggestDirection('2026-08-13T06:00:00.000+0000', '2026-08-13T06:00:00.000+0000'), 'sourceToTarget');
check('시각 정보가 없으면 소스 기준', suggestDirection(undefined, undefined), 'sourceToTarget');

// ---------------------------------------------------------------------------
// 6. 연결 판정 (2단계에서 실측한 JIRA 응답 모양 그대로)
// ---------------------------------------------------------------------------

section('6. 연결 판정 — 실제 JIRA 응답 모양으로 검증');

// BEDEV1-531 이 실제로 돌려준 issuelinks (outward = KQ-18184)
const bedev1_531 = {
  key: 'BEDEV1-531',
  fields: {
    issuelinks: [
      {
        id: '55023',
        type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: { id: '81499', key: 'KQ-18184' },
      },
    ],
  },
} as unknown as JiraIssue;

// KQ-18184 가 실제로 돌려준 issuelinks (같은 링크 id 55023, inward = BEDEV1-531)
const kq_18184 = {
  key: 'KQ-18184',
  fields: {
    issuelinks: [
      {
        id: '55023',
        type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: { id: '81498', key: 'BEDEV1-531' },
      },
    ],
  },
} as unknown as JiraIssue;

check('정방향: 소스에서 대상 키를 찾는다', findBlocksOutwardKeys(bedev1_531, 'KQ'), ['KQ-18184']);
check('역방향: 대상에서 소스 키를 찾는다', findLinkedSourceKeys(kq_18184, 'BEDEV1'), ['BEDEV1-531']);
check('다른 프로젝트 접두사는 걸리지 않는다', findBlocksOutwardKeys(bedev1_531, 'HB'), []);
check(
  '역방향에서 outward 만 있는 링크는 소스로 오인하지 않는다',
  findLinkedSourceKeys(bedev1_531, 'BEDEV1'),
  []
);

// BEDEV1-496 의 실제 customfield_10438 값
const bedev1_496 = {
  key: 'BEDEV1-496',
  fields: { customfield_10438: 'https://hmg.atlassian.net/browse/AUTOWAY-4371' },
} as unknown as JiraIssue;

check(
  '다른 사이트: link field URL 에서 대상 키 추출',
  extractLinkFieldKeys(bedev1_496, { linkField: 'customfield_10438', targetProjectKey: 'AUTOWAY' }),
  ['AUTOWAY-4371']
);
check(
  '다른 사이트: link field 가 비어 있으면 미연결',
  extractLinkFieldKeys(
    { key: 'X', fields: { customfield_10438: null } } as unknown as JiraIssue,
    { linkField: 'customfield_10438', targetProjectKey: 'AUTOWAY' }
  ),
  []
);
check(
  '다른 사이트: 배열 형태 값도 견딘다',
  extractLinkFieldKeys(
    {
      key: 'X',
      fields: { customfield_10438: ['https://hmg.atlassian.net/browse/AUTOWAY-4424'] },
    } as unknown as JiraIssue,
    { linkField: 'customfield_10438', targetProjectKey: 'AUTOWAY' }
  ),
  ['AUTOWAY-4424']
);
check(
  '다른 사이트: 다른 프로젝트 키는 걸리지 않는다',
  extractLinkFieldKeys(bedev1_496, {
    linkField: 'customfield_10438',
    targetProjectKey: 'HMGBOARD',
  }),
  []
);

// ---------------------------------------------------------------------------
// 7. 생성 이슈 타입 결정 (실제 /project/{key} 응답 순서로 검증)
// ---------------------------------------------------------------------------

section('7. 생성 이슈 타입 — 실제 프로젝트 응답 순서로 검증');

// 2026-08 실측: getProject().issueTypes 순서는 프로젝트마다 다르다.
const KQ_TYPES = [
  { id: '10004', name: '버그' },
  { id: '10139', name: 'Ask' },
  { id: '10137', name: '개선' },
  { id: '10169', name: 'Design Issues' },
  { id: '10002', name: '작업' },
  { id: '10001', name: '스토리' },
  { id: '10003', name: '하위 작업', subtask: true },
  { id: '10000', name: '에픽', hierarchyLevel: 1 },
  { id: '10203', name: '운영업무' },
  { id: '10204', name: '기획' },
  { id: '10205', name: '개발처리' },
];

const BEDEV1_TYPES = [
  { id: '10823', name: '작업' },
  { id: '10824', name: '버그' },
  { id: '10825', name: '스토리' },
  { id: '10826', name: '에픽', hierarchyLevel: 1 },
  { id: '10827', name: '하위 작업', subtask: true },
];

const HB_TYPES = [
  { id: '10002', name: '작업' },
  { id: '10003', name: '하위 작업', subtask: true },
  { id: '10001', name: '스토리' },
  { id: '10004', name: '버그' },
  { id: '10000', name: '에픽', hierarchyLevel: 1 },
  { id: '10168', name: 'Design Issue' },
];

// 회귀: KQ 는 응답 배열 첫 항목이 "버그" 라 예전 로직이 버그 티켓을 만들었다 (KQ-18190)
check('KQ → 개발처리 (지정값)', chooseCreateIssueType('KQ', KQ_TYPES)?.name, '개발처리');
check('KQ → id 10205', chooseCreateIssueType('KQ', KQ_TYPES)?.id, '10205');
check('KQ → 근거는 configured', chooseCreateIssueType('KQ', KQ_TYPES)?.reason, 'configured');
check('KQ 는 버그가 아니다 (회귀 방지)', chooseCreateIssueType('KQ', KQ_TYPES)?.name !== '버그', true);

check('BEDEV1 → 작업', chooseCreateIssueType('BEDEV1', BEDEV1_TYPES)?.name, '작업');
check('BEDEV1 → id 10823', chooseCreateIssueType('BEDEV1', BEDEV1_TYPES)?.id, '10823');
check('HB → 작업', chooseCreateIssueType('HB', HB_TYPES)?.name, '작업');

// 선호 순서(작업 → 개발처리 → Dev Task)를 프로젝트 응답 순서보다 우선한다
check(
  '응답 순서가 [버그, 작업] 이어도 작업을 고른다',
  chooseCreateIssueType('ANY', [
    { id: '1', name: '버그' },
    { id: '2', name: '작업' },
  ])?.name,
  '작업'
);
check(
  '작업이 없으면 개발처리',
  chooseCreateIssueType('ANY', [
    { id: '1', name: '버그' },
    { id: '2', name: '개발처리' },
  ])?.name,
  '개발처리'
);
check(
  '작업/개발처리가 없으면 Dev Task',
  chooseCreateIssueType('ANY', [
    { id: '1', name: '버그' },
    { id: '2', name: 'Dev Task' },
  ])?.name,
  'Dev Task'
);
check(
  '작업이 개발처리보다 우선',
  chooseCreateIssueType('ANY', [
    { id: '1', name: '개발처리' },
    { id: '2', name: '작업' },
  ])?.name,
  '작업'
);

// 에픽/하위작업은 절대 고르지 않는다
check(
  '에픽/하위작업만 있으면 null',
  chooseCreateIssueType('ANY', [
    { id: '1', name: '에픽', hierarchyLevel: 1 },
    { id: '2', name: '하위 작업', subtask: true },
  ]),
  null
);

// 셋 다 없으면 임의로 고르지 않는다 (버그 티켓이 만들어지는 것을 막는다)
check(
  '선호 타입이 하나도 없으면 null (임의 선택 금지)',
  chooseCreateIssueType('ANY', [
    { id: '1', name: '버그' },
    { id: '9', name: '운영업무' },
  ]),
  null
);
check(
  '지정 타입이 프로젝트에 없으면 선호 순서로 폴백',
  chooseCreateIssueType('KQ', [{ id: '7', name: '작업' }])?.reason,
  'preference'
);

// ---------------------------------------------------------------------------
// 8. 쓰기 페이로드 정리 (Jira 가 거부하는 필드 처리)
// ---------------------------------------------------------------------------

section('8. 쓰기 페이로드 정리');

// 실제 실패 재현:
// {"errors":{"timeoriginalestimate":"Field 'timeoriginalestimate' cannot be set..."}}
const rawPayload = {
  summary: '제목',
  timeoriginalestimate: 57600,
  timetracking: {
    originalEstimate: '2d',
    remainingEstimate: '2d',
    timeSpent: '1h',
    originalEstimateSeconds: 57600,
    remainingEstimateSeconds: 57600,
    timeSpentSeconds: 3600,
  },
};
const clean = sanitizeWritePayload(rawPayload);

check('timeoriginalestimate 는 페이로드에서 제거된다', 'timeoriginalestimate' in clean, false);
check('summary 는 그대로 남는다', clean.summary, '제목');
check(
  'timetracking 은 설정 가능한 두 키만 남는다',
  clean.timetracking,
  { originalEstimate: '2d', remainingEstimate: '2d' }
);

// timetracking 없이 초 단위 필드만 있는 경우 → timetracking 으로 접는다
check(
  '초 단위 추정치만 있으면 timetracking 으로 변환된다',
  sanitizeWritePayload({ timeoriginalestimate: 57600 }).timetracking,
  { originalEstimate: '2d' }
);
check(
  '남은 추정치도 변환된다',
  sanitizeWritePayload({ timeestimate: 3600 }).timetracking,
  { remainingEstimate: '1h' }
);
check(
  '초 → Jira 기간 문자열 (1d = 8h)',
  sanitizeWritePayload({ timeoriginalestimate: 28800 }).timetracking,
  { originalEstimate: '1d' }
);

// 계산 전용 필드 제거
const withReadOnly = sanitizeWritePayload({
  summary: 'x',
  timespent: 3600,
  aggregatetimespent: 7200,
  progress: { progress: 1, total: 2 },
  workratio: 50,
});
check('계산 전용 필드는 제거된다', Object.keys(withReadOnly), ['summary']);

// 추정치가 아예 없으면 timetracking 키를 만들지 않는다
check(
  '추정치가 없으면 timetracking 키 자체가 없다',
  'timetracking' in sanitizeWritePayload({ summary: 'x' }),
  false
);
check(
  '빈 timetracking 은 제거된다',
  'timetracking' in sanitizeWritePayload({ timetracking: { timeSpent: '1h' } }),
  false
);
check(
  '0 이나 null 추정치는 값으로 치지 않는다',
  'timetracking' in sanitizeWritePayload({ timeoriginalestimate: 0 }),
  false
);

// 원본은 건드리지 않는다
const original = { timeoriginalestimate: 3600 };
sanitizeWritePayload(original);
check('입력 객체를 변형하지 않는다', original.timeoriginalestimate, 3600);

// ---------------------------------------------------------------------------
// 9. 프로젝트 구분 라벨 (BEDEV1 은 라벨로 대상 프로젝트를 구분한다)
// ---------------------------------------------------------------------------

section('9. 프로젝트 구분 라벨');

// 실측 라벨: BEDEV1-529=[KQ], BEDEV1-523=[AUTOWAY], BEDEV1-528=[MEMBERSHIP]
check('BEDEV1-529 는 KQ 대상', hasProjectLabel(['KQ'], 'KQ'), true);
check('BEDEV1-523 은 KQ 대상이 아님', hasProjectLabel(['AUTOWAY'], 'KQ'), false);
check('BEDEV1-523 은 AUTOWAY 대상', hasProjectLabel(['AUTOWAY'], 'AUTOWAY'), true);
check('BEDEV1-528(MEMBERSHIP) 은 KQ 대상이 아님', hasProjectLabel(['MEMBERSHIP'], 'KQ'), false);
check('라벨이 없으면 대상 아님', hasProjectLabel([], 'KQ'), false);
check('labels 가 undefined 여도 안전', hasProjectLabel(undefined, 'KQ'), false);
check('여러 라벨 중 하나만 맞아도 대상', hasProjectLabel(['BE', 'KQ', 'urgent'], 'KQ'), true);
check('대소문자는 무시한다', hasProjectLabel(['kq'], 'KQ'), true);
check('부분 일치는 안 된다', hasProjectLabel(['KQ2'], 'KQ'), false);

// 생성 시 라벨 부여
check('라벨이 없으면 추가한다', withProjectLabel(undefined, 'KQ'), ['KQ']);
check('기존 라벨은 유지한다', withProjectLabel(['BE'], 'KQ'), ['BE', 'KQ']);
check('이미 있으면 중복 추가하지 않는다', withProjectLabel(['KQ'], 'KQ'), ['KQ']);
check('대소문자만 다르면 중복으로 본다', withProjectLabel(['kq'], 'KQ'), ['kq']);
check('AUTOWAY 도 같은 규칙', withProjectLabel(['BE'], 'AUTOWAY'), ['BE', 'AUTOWAY']);

// ---------------------------------------------------------------------------
// 10. 상태 비교 (sync_profile_status_mappings 기반)
// ---------------------------------------------------------------------------

section('10. 상태 비교');

// 실측 매핑 (BEDEV1 -> KQ): 10768("해야 할 일")->1, 10769("진행 중")->3, 10770("완료")->6
const statusSame = compareMappedFields([], {}, targetTicket({}).fields, {
  mappedSourceStatusId: '6',
  sourceStatusName: '완료',
  targetStatusId: '6',
  targetStatusName: '완료',
});
check('상태가 같으면 diff 아님', statusSame.identical, true);
check('상태 행은 항상 표시된다', statusSame.fields.length, 1);
check('상태 행 라벨', statusSame.fields[0].label, '상태');

// 사용자가 겪은 상황: KQ 완료 / BEDEV1 해야 할 일
const statusDiff = compareMappedFields([], {}, targetTicket({}).fields, {
  mappedSourceStatusId: '1',
  sourceStatusName: '해야 할 일',
  targetStatusId: '6',
  targetStatusName: '완료',
});
check('상태가 다르면 diff 로 잡힌다', statusDiff.identical, false);
check('상태 diff 내용', statusDiff.changed[0].label, '상태');
check('소스 상태 이름이 보인다', statusDiff.changed[0].sourceDisplay, '해야 할 일');
check('대상 상태 이름이 보인다', statusDiff.changed[0].targetDisplay, '완료');

check(
  '대상 상태가 없으면 (없음) 으로 표시',
  compareMappedFields([], {}, targetTicket({}).fields, {
    mappedSourceStatusId: '1',
    sourceStatusName: '해야 할 일',
  }).changed[0].targetDisplay,
  '(없음)'
);

// 상태 매핑이 없으면 (status 미전달) 상태 행 자체가 없다
check(
  '상태 매핑이 없으면 상태 행이 없다',
  compareMappedFields([], {}, targetTicket({}).fields).fields.length,
  0
);

// 상태는 필드 diff 와 함께 잡힌다
const mixed = compareMappedFields(
  MAPPINGS,
  { summary: 'A' },
  targetTicket({ summary: 'B' }).fields,
  { mappedSourceStatusId: '1', sourceStatusName: '해야 할 일', targetStatusId: '6', targetStatusName: '완료' }
);
check('상태 + 필드가 함께 잡힌다', mixed.changed.map((d) => d.label).sort(), ['상태', '요약']);

// ---------------------------------------------------------------------------

console.warn(`\n${'='.repeat(50)}`);
console.warn(`통과 ${passed} / 실패 ${failed}`);
console.warn('='.repeat(50));

if (failed > 0) process.exit(1);
