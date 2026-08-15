import { z } from 'zod';
import { DEFAULT_LIMIT, DOMAINS, MAX_LIMIT, REGULATION_TYPES } from '@/constants';
import { display, primaryProposer } from './format';

/** 여러 도구가 공유하는 필터 스키마 조각 */
export const commonFilters = {
  domain: z
    .enum(DOMAINS)
    .optional()
    .describe(
      "정책 분야. economic(경제·7856건), social(사회·7148), administrative(행정·2859), " +
        'political(정치·1831), environmental(환경·201), cultural(문화·104)'
    ),
  regulation_type: z
    .enum(REGULATION_TYPES)
    .optional()
    .describe(
      "규제 성격. 강화(7263건), 신설(4899), 완화(3165), 중립(1064), 비규제(36). " +
        '약 3572건은 분류값이 없어 어떤 값으로도 걸리지 않는다'
    ),
  committee: z
    .string()
    .min(2)
    .max(60)
    .optional()
    .describe(
      '소관 상임위원회 이름의 일부 또는 전체. 예: "정무위원회", "국토교통", "법제사법". 부분 일치로 동작한다'
    ),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다')
    .optional()
    .describe('발의일 시작(포함). 예: "2026-01-01"'),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다')
    .optional()
    .describe('발의일 종료(포함). 예: "2026-06-30"'),
};

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`반환할 최대 건수 (1-${MAX_LIMIT}, 기본 ${DEFAULT_LIMIT})`);

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe('건너뛸 건수. 다음 페이지를 받을 때 이전 응답의 next_offset 값을 넣는다');

export interface BillFilters {
  domain?: string;
  regulation_type?: string;
  committee?: string;
  date_from?: string;
  date_to?: string;
}

/** PostgREST 쿼리 빌더에 공통 필터를 적용한다 */
export function applyFilters<T extends {
  eq: (c: string, v: unknown) => T;
  ilike: (c: string, v: string) => T;
  gte: (c: string, v: unknown) => T;
  lte: (c: string, v: unknown) => T;
}>(query: T, f: BillFilters): T {
  let q = query;
  if (f.domain) q = q.eq('domain', f.domain);
  if (f.regulation_type) q = q.eq('regulation_type', f.regulation_type);
  if (f.committee) q = q.ilike('committee', `%${f.committee}%`);
  if (f.date_from) q = q.gte('proposal_date', f.date_from);
  if (f.date_to) q = q.lte('proposal_date', f.date_to);
  return q;
}

/** 적용된 필터를 사람이 읽을 수 있게 요약 */
export function describeFilters(f: BillFilters): string {
  const parts: string[] = [];
  if (f.domain) parts.push(`분야=${f.domain}`);
  if (f.regulation_type) parts.push(`규제=${f.regulation_type}`);
  if (f.committee) parts.push(`위원회~"${f.committee}"`);
  if (f.date_from) parts.push(`${f.date_from} 이후`);
  if (f.date_to) parts.push(`${f.date_to} 이전`);
  return parts.length ? parts.join(', ') : '없음';
}

/**
 * 응답에서 내부 식별자를 제거한다.
 * 외부에 노출하는 법안 식별자는 의안번호(bill_no) 하나로 통일해
 * 에이전트 컨텍스트를 아끼고 도구 간 입력값을 일관되게 유지한다.
 *
 * bill_id 는 상태 조인 폴백에만 쓰는 내부 키라 여기서 함께 떨어뜨린다.
 */
export function stripInternalIds<T extends { id?: unknown; bill_id?: unknown }>(
  rows: T[]
): Array<Omit<T, 'id' | 'bill_id'>> {
  return rows.map(({ id: _id, bill_id: _billId, ...rest }) => rest);
}

export interface BillRow {
  id?: string;
  bill_id?: string | null;
  bill_no?: string | null;
  bill_name?: string | null;
  proposer?: string | null;
  proposal_date?: string | null;
  committee?: string | null;
  domain?: string | null;
  regulation_type?: string | null;
  summary_one_sentence?: string | null;
  link_url?: string | null;
  similarity?: number;
  /** 목록 렌더 직전에 붙이는 처리 상태 요약 (services/status.ts) */
  status_summary?: string;
}

/** 법안 1건을 마크다운 항목으로 렌더링 (목록용) */
export function renderBillItem(bill: BillRow, index: number): string[] {
  const lines: string[] = [];
  const sim =
    typeof bill.similarity === 'number' ? ` · 유사도 ${(bill.similarity * 100).toFixed(1)}%` : '';

  lines.push(`### ${index}. ${display(bill.bill_name, '(법안명 없음)')}`);
  lines.push(
    `- 의안번호 ${display(bill.bill_no)} · ${display(bill.proposal_date)} · ` +
      `${primaryProposer(bill.proposer)} 대표발의${sim}`
  );
  lines.push(`- ${display(bill.committee, '소관위 미지정')} · ${display(bill.domain)} · 규제 ${display(bill.regulation_type, '미분류')}`);
  if (bill.status_summary) lines.push(`- 상태: ${bill.status_summary}`);

  const summary = display(bill.summary_one_sentence, '');
  if (summary) lines.push(`- ${summary}`);
  if (bill.link_url) lines.push(`- ${bill.link_url}`);
  lines.push('');
  return lines;
}

/** 법안 목록을 마크다운으로 렌더링 */
export function renderBillList(
  title: string,
  bills: BillRow[],
  meta: { total: number; offset: number; filters?: string },
  truncatedNote: string | null
): string {
  const lines: string[] = [`# ${title}`, ''];
  lines.push(`전체 ${meta.total.toLocaleString()}건 중 ${bills.length}건 표시 (offset ${meta.offset})`);
  if (meta.filters) lines.push(`적용 필터: ${meta.filters}`);
  lines.push('');

  bills.forEach((b, i) => lines.push(...renderBillItem(b, meta.offset + i + 1)));

  if (meta.total > meta.offset + bills.length) {
    lines.push(`다음 페이지: offset=${meta.offset + bills.length}`);
  }
  if (truncatedNote) lines.push('', truncatedNote);

  return lines.join('\n');
}
