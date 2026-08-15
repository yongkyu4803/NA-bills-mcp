import { z } from 'zod';
import { CHARACTER_LIMIT, SCOPE_FOOTER, SCOPE_JSON } from '@/constants';
import { freshnessJson, freshnessNote, getStatusFreshness } from './freshness';

/** 모든 도구가 공유하는 응답 형식 옵션 */
export const ResponseFormat = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe("출력 형식. 'markdown'은 사람이 읽기 좋은 형태, 'json'은 후속 처리를 위한 구조화 데이터");

export type ResponseFormatValue = 'markdown' | 'json';

/** MCP 도구 반환 타입 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/**
 * 마크다운 응답에 스코프 경계 안내를 붙여 반환한다.
 *
 * 법안 데이터를 실제로 담아 보내는 응답에만 쓴다. 0건·오류 응답에는 붙이지 않는다 —
 * 그쪽은 이미 "무엇을 대신 하라"를 말하고 있어 안내가 겹치면 잡음이 된다.
 */
export function scopedResult(markdown: string): ToolResult {
  return textResult(`${markdown}\n\n${SCOPE_FOOTER}`);
}

/** JSON 응답 객체에 기계 판독용 스코프 표기를 덧붙인다 */
export function scopedJson(payload: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify({ ...payload, data_scope: SCOPE_JSON }, null, 2));
}

/**
 * 처리 상태를 실제로 담아 보내는 응답용. scopedResult 에 신선도 한 줄을 더 붙인다.
 * 상태를 표시하지 않는 도구(bills_statistics·bills_daily_report)에는 쓰지 않는다 —
 * 상태 경고를 상태 없는 응답에 붙이면 무엇이 낡았다는 건지 알 수 없다.
 */
export async function scopedStatusResult(markdown: string): Promise<ToolResult> {
  const note = freshnessNote(await getStatusFreshness());
  return scopedResult(note ? `${markdown}\n\n${note}` : markdown);
}

/** 처리 상태를 담은 JSON 응답용. data_scope 에 기준일과 stale 여부를 넣는다. */
export async function scopedStatusJson(payload: Record<string, unknown>): Promise<ToolResult> {
  const freshness = await getStatusFreshness();
  return textResult(
    JSON.stringify(
      { ...payload, data_scope: { ...SCOPE_JSON, ...freshnessJson(freshness) } },
      null,
      2
    )
  );
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * 도구 실행을 감싸 예외를 LLM 이 대응 가능한 문구로 변환한다.
 * 내부 구현 세부사항은 노출하지 않는다.
 */
export async function runTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`오류: ${message}`);
  }
}

/** 페이지네이션 메타데이터 */
export interface Pagination {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export function buildPagination(total: number, count: number, offset: number): Pagination {
  const hasMore = total > offset + count;
  return {
    total,
    count,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + count } : {}),
  };
}

/**
 * 문자 수 상한을 넘으면 항목을 절반씩 줄여가며 다시 렌더링한다.
 * 잘린 경우 어떻게 더 가져올 수 있는지 안내 문구를 덧붙인다.
 */
export function renderWithLimit<T>(
  items: T[],
  render: (subset: T[], truncatedNote: string | null) => string
): string {
  let subset = items;
  let output = render(subset, null);

  while (output.length > CHARACTER_LIMIT && subset.length > 1) {
    subset = subset.slice(0, Math.max(1, Math.floor(subset.length / 2)));
    const note =
      `※ 응답이 너무 길어 ${items.length}건 중 ${subset.length}건만 표시했습니다. ` +
      `'limit'을 줄이거나 'offset'으로 다음 페이지를 요청하거나, 필터(domain·committee·date_from 등)를 추가하세요.`;
    output = render(subset, note);
  }

  return output;
}

/** null/빈 문자열을 표시용 문자열로 정규화 */
export function display(value: unknown, fallback = '정보 없음'): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s.length > 0 ? s : fallback;
}

/** 발의자 문자열에서 대표발의자만 추출 (예: "홍길동의원 등 12인" → "홍길동") */
export function primaryProposer(proposer: unknown): string {
  const s = display(proposer, '');
  if (!s) return '정보 없음';
  const match = s.match(/^([^\s,]+?)(의원|위원장)?(\s|,|$)/);
  return match?.[1] ?? s;
}
