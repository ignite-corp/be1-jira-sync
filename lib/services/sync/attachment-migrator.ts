// 첨부파일 / 인라인 스크린샷 마이그레이션
//
// 동작:
//  1. 소스 티켓의 모든 첨부파일을 대상 티켓으로 복사 (파일명+크기로 중복 방지)
//  2. 본문(description) ADF의 인라인 이미지(media 노드)를 대상 인스턴스의
//     새 Media Services UUID로 재매핑 → 본문 안에서도 이미지가 렌더링됨
//
// 인라인 재매핑은 인스턴스가 다를 때(예: ignite → hmg)만 필요하다.
// 같은 Atlassian 조직(ignite → ignite)은 media UUID가 그대로 유효하므로 건드리지 않는다.

import { JiraIssue, JiraDescription, JiraAttachment } from '@/lib/types/jira';
import { JiraClient } from '@/lib/services/jira/client';
import { SyncLogger } from './logger';

export interface AttachmentMigrationResult {
  copied: number; // 새로 업로드된 첨부 수
  skipped: number; // 이미 존재해 건너뛴 첨부 수
  failed: number; // 다운로드/업로드 실패 수
  descriptionUpdated: boolean; // 본문 인라인 이미지 재매핑 적용 여부
}

const EMPTY_RESULT: AttachmentMigrationResult = {
  copied: 0,
  skipped: 0,
  failed: 0,
  descriptionUpdated: false,
};

/**
 * 소스 티켓의 첨부파일 + 인라인 스크린샷을 대상 티켓으로 옮긴다.
 */
export async function migrateAttachments(params: {
  sourceInstance: 'ignite' | 'hmg';
  targetInstance: 'ignite' | 'hmg';
  sourceTicket: JiraIssue;
  targetKey: string;
  logger: SyncLogger;
  /** DB 매핑처럼 본문이 소스를 그대로 미러링하는 경우에만 true (AUTOWAY 링크 본문은 false) */
  allowDescriptionRemap: boolean;
}): Promise<AttachmentMigrationResult> {
  const {
    sourceInstance,
    targetInstance,
    sourceTicket,
    targetKey,
    logger,
    allowDescriptionRemap,
  } = params;

  const sourceAttachments = sourceTicket.fields.attachment ?? [];
  if (sourceAttachments.length === 0) {
    return EMPTY_RESULT;
  }

  const sourceClient = new JiraClient(sourceInstance);
  const targetClient = new JiraClient(targetInstance);

  // 인라인 이미지 재매핑이 필요한지 판단
  const description = sourceTicket.fields.description;
  const crossInstance = sourceInstance !== targetInstance;
  const sourceUuidsInBody = collectMediaUuids(description);
  const needBodyRemap =
    allowDescriptionRemap && crossInstance && sourceUuidsInBody.size > 0;

  // 대상 티켓의 기존 첨부 조회 (중복 업로드 방지)
  const existingByKey = await fetchExistingAttachments(targetClient, targetKey);

  const uuidMap = new Map<string, string>(); // 소스 media UUID → 대상 media UUID
  const result: AttachmentMigrationResult = { ...EMPTY_RESULT };

  for (const att of sourceAttachments) {
    const dedupKey = `${att.filename}|${att.size}`;
    let targetAttachmentId: string | null = null;

    const existing = existingByKey.get(dedupKey);
    if (existing) {
      targetAttachmentId = existing.id;
      result.skipped++;
    } else {
      const uploadedId = await copyAttachment(
        sourceClient,
        targetClient,
        targetKey,
        att,
        logger
      );
      if (!uploadedId) {
        result.failed++;
        continue;
      }
      targetAttachmentId = uploadedId;
      result.copied++;
    }

    // 본문 인라인 재삽입은 "이미지(스크린샷)"에만 적용한다.
    // 비이미지 첨부(.py, .pdf 등)를 본문 media 노드로 넣으면 HMG가
    // ATTACHMENT_VALIDATION_ERROR 로 description 업데이트 전체를 거부한다.
    // → 일반 파일은 본문에서 제외하고 첨부 패널에만 남긴다(파일 복사는 위에서 완료).
    const isImage = (att.mimeType || '').toLowerCase().startsWith('image/');
    if (needBodyRemap && isImage && targetAttachmentId) {
      const sourceUuid = await sourceClient.resolveMediaUuid(att.id);
      if (sourceUuid && sourceUuidsInBody.has(sourceUuid)) {
        const targetUuid = await targetClient.resolveMediaUuid(
          targetAttachmentId
        );
        if (targetUuid) {
          uuidMap.set(sourceUuid, targetUuid);
        }
      }
    }
  }

  // 본문 재매핑 후 대상 description 업데이트
  if (needBodyRemap && uuidMap.size > 0) {
    const remapped = remapDescriptionMedia(description, uuidMap);
    const updateResult = await targetClient.put(`issue/${targetKey}`, {
      fields: { description: remapped },
    });
    if (updateResult.success) {
      result.descriptionUpdated = true;
    } else {
      const details = (updateResult as { details?: unknown }).details;
      logger.warning(
        `${targetKey}: 본문 인라인 이미지 재매핑 실패 - ${updateResult.error}` +
          (details ? ` / 상세: ${JSON.stringify(details)}` : '') +
          ` / 보낸 media 노드: ${JSON.stringify([...uuidMap.entries()])}`
      );
    }
  }

  logger.info(
    `${targetKey}: 첨부 동기화 (복사 ${result.copied} / 건너뜀 ${result.skipped} / 실패 ${result.failed}${
      result.descriptionUpdated ? ' / 본문 이미지 재매핑' : ''
    })`
  );

  return result;
}

/**
 * 대상 티켓의 기존 첨부를 (파일명|크기) → 첨부 맵으로 조회
 */
async function fetchExistingAttachments(
  client: JiraClient,
  issueKey: string
): Promise<Map<string, JiraAttachment>> {
  const map = new Map<string, JiraAttachment>();
  const res = await client.get<{ fields?: { attachment?: JiraAttachment[] } }>(
    `issue/${issueKey}`,
    { fields: 'attachment' }
  );
  const list = res.success ? res.data?.fields?.attachment ?? [] : [];
  for (const att of list) {
    map.set(`${att.filename}|${att.size}`, att);
  }
  return map;
}

/**
 * 첨부 1개를 다운로드 후 대상 티켓에 업로드 → 새 첨부 ID 반환
 */
async function copyAttachment(
  sourceClient: JiraClient,
  targetClient: JiraClient,
  targetKey: string,
  att: JiraAttachment,
  logger: SyncLogger
): Promise<string | null> {
  const downloaded = await sourceClient.downloadAttachment(att.id);
  if (!downloaded) {
    logger.warning(`${targetKey}: 첨부 다운로드 실패 (${att.filename})`);
    return null;
  }

  const uploaded = await targetClient.uploadAttachment(
    targetKey,
    att.filename,
    att.mimeType || downloaded.mimeType,
    downloaded.base64
  );
  if (!uploaded || uploaded.length === 0) {
    logger.warning(`${targetKey}: 첨부 업로드 실패 (${att.filename})`);
    return null;
  }

  return uploaded[0].id;
}

/**
 * ADF 문서에서 media/mediaInline 노드의 id(=Media Services UUID) 집합 수집
 */
export function collectMediaUuids(
  doc: JiraDescription | string | null | undefined
): Set<string> {
  const uuids = new Set<string>();
  if (!doc || typeof doc !== 'object') return uuids;

  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type?: string;
      attrs?: { id?: unknown };
      content?: unknown[];
    };
    if (
      (n.type === 'media' || n.type === 'mediaInline') &&
      typeof n.attrs?.id === 'string'
    ) {
      uuids.add(n.attrs.id);
    }
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
    }
  };

  walk(doc);
  return uuids;
}

/**
 * ADF 문서의 media 노드 id를 대상 UUID로 교체.
 * 매핑되지 않은(=복사/해석 실패) media 노드는 깨진 참조를 남기지 않도록 제거한다.
 */
export function remapDescriptionMedia(
  doc: JiraDescription | string | null | undefined,
  uuidMap: Map<string, string>
): JiraDescription | string | null | undefined {
  if (!doc || typeof doc !== 'object') return doc;

  const transform = (node: unknown): unknown | null => {
    if (!node || typeof node !== 'object') return node;
    const n = node as {
      type?: string;
      attrs?: { id?: unknown; collection?: unknown; [k: string]: unknown };
      content?: unknown[];
      [k: string]: unknown;
    };

    // media / mediaInline: 매핑되면 교체, 아니면 제거
    if (n.type === 'media' || n.type === 'mediaInline') {
      const id = typeof n.attrs?.id === 'string' ? n.attrs.id : null;
      if (id && uuidMap.has(id)) {
        return {
          ...n,
          attrs: { ...n.attrs, id: uuidMap.get(id), collection: '' },
        };
      }
      return null; // 매핑 실패 → 깨진 참조 제거
    }

    // 자식 노드 재귀 처리
    if (Array.isArray(n.content)) {
      const newContent = n.content
        .map(transform)
        .filter((c): c is unknown => c !== null);
      // mediaSingle/mediaGroup 같은 래퍼가 비면 통째로 제거
      const isMediaWrapper =
        n.type === 'mediaSingle' || n.type === 'mediaGroup';
      if (isMediaWrapper && newContent.length === 0) {
        return null;
      }
      return { ...n, content: newContent };
    }

    return n;
  };

  return transform(doc) as JiraDescription | string | null | undefined;
}
