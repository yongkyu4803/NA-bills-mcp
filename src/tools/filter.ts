import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { DATA_COVERAGE, SCOPE_NOTICE } from '@/constants';
import { getDb, BILL_LIST_COLUMNS } from '@/services/supabase';
import {
  ResponseFormat,
  buildPagination,
  renderWithLimit,
  runTool,
  scopedJson,
  scopedResult,
  scopedStatusJson,
  scopedStatusResult,
  textResult,
} from '@/services/format';
import {
  applyFilters,
  commonFilters,
  describeFilters,
  limitField,
  offsetField,
  renderBillList,
  stripInternalIds,
  type BillRow,
} from '@/services/bills';
import { attachStatusSummaries } from '@/services/status';

const InputSchema = z
  .object({
    keyword: z
      .string()
      .min(2, '키워드는 2자 이상이어야 합니다')
      .max(100)
      .optional()
      .describe(
        '법안명에 포함된 문자열로 부분 일치 검색. 예: "주택임대차", "개인정보". ' +
          '의미 기반으로 찾고 싶으면 이 도구 대신 bills_search 를 쓴다'
      ),
    ...commonFilters,
    sort: z
      .enum(['newest', 'oldest'])
      .default('newest')
      .describe('발의일 기준 정렬 순서'),
    limit: limitField,
    offset: offsetField,
    response_format: ResponseFormat,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerFilter(server: McpServer): void {
  server.registerTool(
    'bills_filter',
    {
      title: '법안 조건 검색',
      description: `국회 발의 법안을 분야·위원회·규제성격·발의기간 등 구조적 조건으로 조회한다 (${DATA_COVERAGE.assembly}, ${DATA_COVERAGE.from}~${DATA_COVERAGE.to}).

의미 유추 없이 지정한 조건에 정확히 맞는 법안을 발의일 순으로 반환한다. 페이지네이션을 지원한다.
읽기 전용이며 데이터를 변경하지 않는다.

${SCOPE_NOTICE}
각 법안에 처리 상태 요약(status_summary)이 함께 붙는다. 다만 **상태로 거르는 필터 인자는 아직 없다** —
"계류 중인 환경 법안"처럼 상태로 좁히려면 결과를 받아 status_summary 로 직접 걸러야 한다.

언제 쓰나:
  - "이번 달 정무위원회에 올라온 법안" → committee="정무위원회", date_from="2026-08-01"
  - "규제를 완화하는 경제 법안 최신순" → domain="economic", regulation_type="완화"
  - "법안명에 '개인정보'가 들어간 것" → keyword="개인정보"
  - 내용 기반으로 찾고 싶으면 bills_search 를 쓴다 (예: "가맹점주 보호" 같은 서술형 질의)
  - 조건 없이 전체 통계만 알고 싶으면 bills_statistics 를 쓴다

인자를 하나도 주지 않으면 최근 발의 법안을 최신순으로 반환한다.

반환값 (response_format="json"):
{
  "total": number,        // 조건에 맞는 전체 건수
  "count": number,
  "offset": number,
  "bills": [ { "bill_no", "bill_name", "proposer", "proposal_date",
               "committee", "domain", "regulation_type",
               "summary_one_sentence", "link_url" } ],
  "has_more": boolean,
  "next_offset": number   // has_more 가 true 일 때만
}

오류 대응:
  - 결과 0건 → 필터를 하나씩 제거하거나 기간을 넓힌다. regulation_type 은 약 3572건이 미분류라 지정 시 누락될 수 있다
  - 결과가 너무 많음 → date_from/date_to 로 기간을 좁히거나 committee 를 지정한다`,
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

        let query = db
          .from('bills_monitor_bills')
          .select(BILL_LIST_COLUMNS, { count: 'exact' });

        query = applyFilters(query, params);
        if (params.keyword) query = query.ilike('bill_name', `%${params.keyword}%`);

        query = query
          .order('proposal_date', { ascending: params.sort === 'oldest' })
          .range(params.offset, params.offset + params.limit - 1);

        const { data, error, count } = await query;
        if (error) throw new Error(`법안 조회에 실패했습니다: ${error.message}`);

        const bills = (data ?? []) as BillRow[];
        const total = count ?? bills.length;

        const filterText = [
          params.keyword ? `법안명~"${params.keyword}"` : null,
          describeFilters(params) === '없음' ? null : describeFilters(params),
        ]
          .filter(Boolean)
          .join(', ');

        if (bills.length === 0) {
          return textResult(
            `조건에 맞는 법안이 없습니다 (적용 필터: ${filterText || '없음'}).\n` +
              `필터를 하나씩 제거하거나 기간을 넓혀 보세요. ` +
              `regulation_type 은 약 3572건이 미분류 상태라 지정하면 해당 건들이 빠집니다.`
          );
        }

        await attachStatusSummaries(bills);

        if (params.response_format === 'json') {
          return scopedStatusJson({
            ...buildPagination(total, bills.length, params.offset),
            bills: stripInternalIds(bills),
          });
        }

        return scopedStatusResult(
          renderWithLimit(bills, (subset, note) =>
            renderBillList('법안 조건 검색 결과', subset, {
              total,
              offset: params.offset,
              filters: filterText || '없음',
            }, note)
          )
        );
      })
  );
}
