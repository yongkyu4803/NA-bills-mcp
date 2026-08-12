import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { DATA_COVERAGE, MAX_LIMIT } from '@/constants';
import { BILL_LIST_COLUMNS, fetchBillsByIds, getDb } from '@/services/supabase';
import { embedQuery, isSemanticSearchAvailable } from '@/services/embeddings';
import {
  ResponseFormat,
  buildPagination,
  errorResult,
  renderWithLimit,
  runTool,
  textResult,
} from '@/services/format';
import {
  applyFilters,
  commonFilters,
  describeFilters,
  renderBillList,
  stripInternalIds,
  type BillRow,
} from '@/services/bills';

const InputSchema = z
  .object({
    query: z
      .string()
      .min(2, '검색어는 2자 이상이어야 합니다')
      .max(300, '검색어는 300자를 넘을 수 없습니다')
      .describe(
        '찾으려는 내용을 자연어로 서술. 법안명이 아니라 "무엇에 관한 법인지"를 쓸수록 정확하다. ' +
          '예: "전세 사기 피해자 보호", "플랫폼 노동자 산재보험 적용", "반도체 기업 세액공제 확대"'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(10)
      .describe(`반환할 최대 건수 (1-${MAX_LIMIT}, 기본 10)`),
    min_similarity: z
      .number()
      .min(0)
      .max(1)
      .default(0.3)
      .describe(
        '최소 코사인 유사도(0-1, 기본 0.3). 결과가 너무 많고 관련성이 낮으면 0.4~0.5로 올리고, ' +
          '결과가 0건이면 0.2로 낮춘다'
      ),
    ...commonFilters,
    response_format: ResponseFormat,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

export function registerSearch(server: McpServer): void {
  server.registerTool(
    'bills_search',
    {
      title: '법안 의미 기반 검색',
      description: `대한민국 국회 발의 법안을 자연어 의미로 검색한다 (${DATA_COVERAGE.assembly}, ${DATA_COVERAGE.from}~${DATA_COVERAGE.to}, 약 2만건).

법안명에 검색어가 그대로 없어도 내용이 유사하면 찾아낸다. 각 법안에는 사람이 읽기 쉬운 한 줄 요약이 붙어 있다.
읽기 전용이며 데이터를 변경하지 않는다.

언제 쓰나:
  - "전세 사기 관련 법안 있어?" → query="전세 사기 피해자 보호"
  - "작년 하반기 플랫폼 노동 규제 강화 법안" → query="플랫폼 노동자 보호", date_from="2025-07-01", regulation_type="강화"
  - 정확한 법안명이나 의안번호를 이미 안다면 bills_get 을 쓴다
  - 의미가 아니라 조건(위원회·기간·분야)으로만 훑고 싶으면 bills_filter 를 쓴다
  - 특정 의원의 발의 목록이 필요하면 bills_by_legislator 를 쓴다

반환값 (response_format="json"):
{
  "query": string,
  "total": number,          // 유사도 기준을 넘긴 총 건수
  "count": number,          // 이번 응답의 건수
  "offset": 0,
  "bills": [
    {
      "bill_no": string,              // 의안번호 (bills_get 입력값)
      "bill_name": string,
      "proposer": string,             // 원문 발의자 문자열
      "proposal_date": string,        // YYYY-MM-DD
      "committee": string | null,
      "domain": string,
      "regulation_type": string | null,
      "summary_one_sentence": string,
      "link_url": string,
      "similarity": number            // 0-1 코사인 유사도
    }
  ],
  "has_more": boolean
}

오류 대응:
  - "시맨틱 검색이 설정되어 있지 않습니다" → 서버에 임베딩 키가 없다. bills_filter 로 키워드 검색할 것
  - 결과 0건 → min_similarity 를 0.2로 낮추거나, 필터를 제거하거나, 더 일반적인 표현으로 다시 질의`,
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
        if (!isSemanticSearchAvailable()) {
          return errorResult(
            '이 서버에는 시맨틱 검색이 설정되어 있지 않습니다. bills_filter 도구로 키워드·조건 검색을 사용하세요.'
          );
        }

        const embedding = await embedQuery(params.query);
        const db = getDb();

        // 필터 적용 후에도 충분한 결과가 남도록 넉넉히 후보를 받아온다
        const candidateCount = Math.min(params.limit * 5, 200);

        const { data: matches, error } = await db.rpc('match_bills_v3', {
          query_embedding: embedding,
          match_threshold: params.min_similarity,
          match_count: candidateCount,
        });

        if (error) throw new Error(`검색에 실패했습니다: ${error.message}`);

        const hits = (matches ?? []) as Array<{ id: string; similarity: number }>;
        if (hits.length === 0) {
          return textResult(
            `"${params.query}"에 대한 검색 결과가 없습니다.\n` +
              `min_similarity 를 0.2로 낮추거나, 필터를 제거하거나, 더 일반적인 표현으로 다시 검색해 보세요.`
          );
        }

        const simById = new Map(hits.map((h) => [h.id, h.similarity]));

        let rows: BillRow[];
        try {
          rows = await fetchBillsByIds<BillRow>(
            hits.map((h) => h.id),
            BILL_LIST_COLUMNS,
            (q) => applyFilters(q, params)
          );
        } catch (e) {
          throw new Error(
            `법안 정보 조회에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        const bills: BillRow[] = rows
          .map((b) => ({ ...b, similarity: simById.get(b.id as string) ?? 0 }))
          .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

        const total = bills.length;
        const page = bills.slice(0, params.limit);

        if (page.length === 0) {
          return textResult(
            `"${params.query}"에 유사한 법안은 찾았지만 지정한 필터(${describeFilters(params)})를 만족하는 건이 없습니다.\n` +
              `필터를 완화하거나 제거한 뒤 다시 시도하세요.`
          );
        }

        if (params.response_format === 'json') {
          return textResult(
            JSON.stringify(
              {
                query: params.query,
                ...buildPagination(total, page.length, 0),
                bills: stripInternalIds(page),
              },
              null,
              2
            )
          );
        }

        return textResult(
          renderWithLimit(page, (subset, note) =>
            renderBillList(`법안 검색: "${params.query}"`, subset, {
              total,
              offset: 0,
              filters: describeFilters(params),
            }, note)
          )
        );
      })
  );
}
