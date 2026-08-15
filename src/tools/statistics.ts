import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getDb } from '@/services/supabase';
import {
  ResponseFormat,
  runTool,
  scopedJson,
  scopedResult,
  textResult,
} from '@/services/format';
import { SCOPE_NOTICE, STATUS_UNSUPPORTED_NOTE } from '@/constants';
import { applyFilters, commonFilters, describeFilters } from '@/services/bills';

/** 집계를 위해 스캔하는 최대 행 수 */
const SCAN_CAP = 25_000;
const PAGE = 1_000;

const InputSchema = z
  .object({
    group_by: z
      .enum(['domain', 'regulation_type', 'committee', 'month'])
      .describe(
        "집계 기준. domain(정책분야), regulation_type(규제성격), committee(소관위원회), month(발의 월별 추이)"
      ),
    ...commonFilters,
    top: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('상위 몇 개 항목까지 표시할지 (기본 20). month 기준일 때는 최근 순으로 자른다'),
    response_format: ResponseFormat,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

/** 집계 대상 컬럼만 페이지 단위로 읽어온다 (임베딩 등 큰 컬럼은 제외) */
async function scanColumn(
  db: SupabaseClient,
  column: string,
  filters: Input
): Promise<{ values: Array<string | null>; total: number; capped: boolean }> {
  const values: Array<string | null> = [];
  let offset = 0;
  let total = 0;

  for (;;) {
    let q = db
      .from('bills_monitor_bills')
      .select(column, { count: 'exact' })
      .range(offset, offset + PAGE - 1);

    q = applyFilters(q, filters);

    const { data, error, count } = await q;
    if (error) throw new Error(`통계 집계에 실패했습니다: ${error.message}`);

    total = count ?? total;
    // 동적 컬럼명을 쓰기 때문에 supabase-js 가 행 타입을 추론하지 못한다
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      const v = r[column];
      values.push(v === null || v === undefined || v === '' ? null : String(v));
    }

    offset += rows.length;
    if (rows.length < PAGE || offset >= total || offset >= SCAN_CAP) break;
  }

  return { values, total, capped: total > SCAN_CAP };
}

export function registerStatistics(server: McpServer): void {
  server.registerTool(
    'bills_statistics',
    {
      title: '법안 발의 통계',
      description: `발의 법안을 분야·규제성격·위원회·월별로 집계해 분포와 추이를 보여준다 (제22대 국회).

개별 법안을 나열하는 대신 "어디에 얼마나 몰려 있는가"를 파악할 때 쓴다. 필터를 걸면 그 부분집합만 집계한다.
읽기 전용이며 데이터를 변경하지 않는다.

${SCOPE_NOTICE}

${STATUS_UNSUPPORTED_NOTE}
집계 단위는 전부 **발의 건수**다. "올해 몇 건 통과됐어?" 처럼 처리 결과를 집계하는 축은 아직
없으므로, 이 도구의 수치를 가결 건수로 소개하면 안 된다.

언제 쓰나:
  - "올해 어느 상임위에 법안이 가장 많이 갔어?" → group_by="committee", date_from="2026-01-01"
  - "규제 강화 vs 완화 비율" → group_by="regulation_type"
  - "월별 발의 추이" → group_by="month"
  - "환경 분야 법안은 어느 위원회로?" → group_by="committee", domain="environmental"
  - 개별 법안 목록이 필요하면 bills_filter 를 쓴다

반환값 (response_format="json"):
{
  "group_by": string,
  "filters": string,          // 적용된 필터 요약
  "total_bills": number,      // 집계 대상 총 건수
  "groups": [
    { "key": string,          // 분류값 ("(미분류)" = null 인 건들)
      "count": number,
      "share": number }       // 전체 대비 비율(%) 소수 1자리
  ],
  "truncated": boolean        // 상위 top 개로 잘렸는지
}

주의:
  - regulation_type 은 약 3572건이 미분류라 "(미분류)" 그룹으로 집계된다
  - committee 는 약 3840건이 미지정 상태다
  - 집계 대상이 ${SCAN_CAP.toLocaleString()}건을 넘으면 앞부분만 스캔하며 응답에 표시된다. 기간 필터로 좁힐 것`,
      inputSchema: InputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: Input) =>
      runTool(async () => {
        const db = getDb();
        const column = params.group_by === 'month' ? 'proposal_date' : params.group_by;

        const { values, total, capped } = await scanColumn(db, column, params);

        if (values.length === 0) {
          return textResult(
            `집계할 법안이 없습니다 (적용 필터: ${describeFilters(params)}).\n필터를 완화해 보세요.`
          );
        }

        const counts = new Map<string, number>();
        for (const raw of values) {
          const key =
            params.group_by === 'month'
              ? (raw ?? '').slice(0, 7) || '(날짜 없음)'
              : (raw ?? '(미분류)');
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        let entries = [...counts.entries()];
        entries =
          params.group_by === 'month'
            ? entries.sort((a, b) => b[0].localeCompare(a[0]))
            : entries.sort((a, b) => b[1] - a[1]);

        const truncated = entries.length > params.top;
        const shown = entries.slice(0, params.top);
        const scanned = values.length;

        const groups = shown.map(([key, count]) => ({
          key,
          count,
          share: Number(((count / scanned) * 100).toFixed(1)),
        }));

        if (params.response_format === 'json') {
          return scopedJson({
            group_by: params.group_by,
            filters: describeFilters(params),
            total_bills: scanned,
            groups,
            truncated,
            ...(capped ? { scan_capped_at: SCAN_CAP } : {}),
          });
        }

        const labels: Record<Input['group_by'], string> = {
          domain: '정책 분야별',
          regulation_type: '규제 성격별',
          committee: '소관 위원회별',
          month: '발의 월별',
        };

        const lines: string[] = [`# 법안 발의 통계 — ${labels[params.group_by]}`, ''];
        lines.push(`집계 대상 ${scanned.toLocaleString()}건 · 적용 필터: ${describeFilters(params)}`, '');

        const width = Math.max(...groups.map((g) => g.key.length));
        for (const g of groups) {
          const bar = '█'.repeat(Math.max(1, Math.round(g.share / 2)));
          lines.push(
            `${g.key.padEnd(width)}  ${String(g.count).padStart(6)}건  ${String(g.share).padStart(5)}%  ${bar}`
          );
        }

        if (truncated) {
          lines.push('', `※ 전체 ${entries.length}개 그룹 중 상위 ${params.top}개만 표시했습니다. 'top' 값을 올리세요.`);
        }
        if (capped) {
          lines.push(
            '',
            `※ 대상이 ${SCAN_CAP.toLocaleString()}건을 넘어 앞부분만 집계했습니다. date_from/date_to 로 기간을 좁히면 정확해집니다.`
          );
        }

        return scopedResult(lines.join('\n'));
      })
  );
}
