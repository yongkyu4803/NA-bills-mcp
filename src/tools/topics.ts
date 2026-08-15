import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDb } from '@/services/supabase';
import {
  ResponseFormat,
  buildPagination,
  display,
  renderWithLimit,
  runTool,
  scopedJson,
  scopedResult,
  textResult,
} from '@/services/format';
import { limitField, offsetField, stripInternalIds } from '@/services/bills';
import { DOMAINS, SCOPE_NOTICE, STATUS_UNSUPPORTED_NOTE } from '@/constants';
import { attachStatusSummaries } from '@/services/status';

const InputSchema = z
  .object({
    cluster_id: z
      .string()
      .uuid('cluster_id 는 UUID 형식이어야 합니다')
      .optional()
      .describe(
        '특정 법안군의 상세와 소속 법안 목록을 조회. bills_get 응답의 topic_cluster_id 값을 넣는다. ' +
          '지정하면 keyword/domain 은 무시된다'
      ),
    keyword: z
      .string()
      .min(2)
      .max(60)
      .optional()
      .describe('법안군 이름·주제에 포함된 문자열로 검색. 예: "부동산", "인공지능"'),
    domain: z.enum(DOMAINS).optional().describe('해당 정책 분야를 포함하는 법안군만 조회'),
    min_bills: z
      .number()
      .int()
      .min(2)
      .max(500)
      .default(2)
      .describe('법안군에 속한 최소 법안 수 (기본 2). 큰 흐름만 보려면 5~10으로 올린다'),
    limit: limitField,
    offset: offsetField,
    response_format: ResponseFormat,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

/**
 * 클러스터명 일부에 "(23건)" 같은 건수 표기가 이미 들어 있어,
 * 렌더링 시 건수를 덧붙이면 중복된다. 말미의 건수 표기를 제거한다.
 */
function cleanClusterName(name: unknown): string {
  return display(name).replace(/\s*\(\d+건\)\s*$/, '');
}

interface ClusterRow {
  cluster_id: string;
  cluster_name: string | null;
  primary_topic: string | null;
  secondary_topics: string[] | null;
  total_bills: number | null;
  domains: string[] | null;
  committees: string[] | null;
  representative_bill_id: string | null;
  is_manual: boolean | null;
}

export function registerTopics(server: McpServer): void {
  server.registerTool(
    'bills_topics',
    {
      title: '법안 주제 클러스터',
      description: `비슷한 주제의 법안들을 묶은 "법안군"(토픽 클러스터) 278개를 조회한다.

같은 사안을 두고 여러 의원이 각각 발의한 경쟁 법안들을 한 덩어리로 보여준다.
개별 법안을 훑기 전에 "지금 국회에서 어떤 주제가 뭉쳐 있는가"를 파악할 때 유용하다.
읽기 전용이며 데이터를 변경하지 않는다.

${SCOPE_NOTICE}

${STATUS_UNSUPPORTED_NOTE}
단, cluster_id 로 상세 조회하면 소속 법안마다 status_summary 가 붙으므로 "이 법안군에서 뭐가
통과됐나"는 결과를 받아 직접 셀 수 있다.

두 가지 사용법:
  1) 목록 조회 — keyword/domain/min_bills 로 법안군을 찾는다
     예: "부동산 관련 법안군" → keyword="부동산"
     예: "법안이 10건 이상 몰린 주제" → min_bills=10
  2) 상세 조회 — cluster_id 를 주면 그 법안군에 속한 법안 목록을 반환한다
     예: bills_get 결과의 topic_cluster_id 를 그대로 넘긴다

언제 안 쓰나:
  - 특정 법안 1건의 내용이 궁금하면 bills_get
  - 조건별 법안 나열이 목적이면 bills_filter

반환값 — 목록 조회 (response_format="json"):
{
  "total": number, "count": number, "offset": number,
  "clusters": [ { "cluster_id": string, "cluster_name": string,
                  "primary_topic": string, "secondary_topics": string[],
                  "total_bills": number, "domains": string[],
                  "committees": string[] } ],
  "has_more": boolean
}

반환값 — 상세 조회 (cluster_id 지정 시):
{
  "cluster": { ...위와 동일 },
  "bills": [ { "bill_no", "bill_name", "proposal_date", "proposer",
               "committee", "summary_one_sentence" } ]
}

오류 대응:
  - 결과 0건 → keyword 를 더 일반적인 단어로 바꾸거나 min_bills 를 2로 낮춘다
  - cluster_id 를 찾을 수 없음 → UUID 를 확인한다. bills_get 의 topic_cluster_id 가 null 이면 그 법안은 어느 군에도 속하지 않는다`,
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
        const CLUSTER_COLS =
          'cluster_id, cluster_name, primary_topic, secondary_topics, total_bills, domains, committees, representative_bill_id, is_manual';

        // ── 상세 조회 ──────────────────────────────────────────
        if (params.cluster_id) {
          const { data: found, error } = await db
            .from('bill_topic_clusters')
            .select(CLUSTER_COLS)
            .eq('cluster_id', params.cluster_id)
            .limit(1);

          if (error) throw new Error(`법안군 조회에 실패했습니다: ${error.message}`);

          const cluster = found?.[0] as ClusterRow | undefined;
          if (!cluster) {
            return textResult(
              `cluster_id "${params.cluster_id}" 법안군을 찾을 수 없습니다.\n` +
                `bills_get 응답의 topic_cluster_id 를 확인하세요. 값이 null 이면 해당 법안은 어느 법안군에도 속하지 않습니다.`
            );
          }

          const { data: billRows } = await db
            .from('bills_monitor_bills')
            .select('bill_id, bill_no, bill_name, proposal_date, proposer, committee, summary_one_sentence')
            .eq('topic_cluster_id', params.cluster_id)
            .order('proposal_date', { ascending: false })
            .limit(100);

          const bills = (billRows ?? []) as Array<Record<string, unknown> & {
            bill_id?: string | null;
            bill_no?: string | null;
            status_summary?: string;
          }>;
          await attachStatusSummaries(bills);

          if (params.response_format === 'json') {
            return scopedJson({ cluster, bills: stripInternalIds(bills) });
          }

          const lines: string[] = [`# 법안군: ${cleanClusterName(cluster.cluster_name)}`, ''];
          lines.push(`주제: ${display(cluster.primary_topic)}`);
          if (cluster.secondary_topics?.length) {
            lines.push(`연관 주제: ${cluster.secondary_topics.join(', ')}`);
          }
          lines.push(`소속 법안 ${cluster.total_bills ?? bills.length}건`);
          if (cluster.domains?.length) lines.push(`분야: ${cluster.domains.join(', ')}`);
          if (cluster.committees?.length) lines.push(`위원회: ${cluster.committees.join(', ')}`);
          lines.push('');

          bills.forEach((b, i) => {
            lines.push(`### ${i + 1}. ${display(b.bill_name)}`);
            lines.push(`- 의안번호 ${display(b.bill_no)} · ${display(b.proposal_date)} · ${display(b.proposer)}`);
            if (b.status_summary) lines.push(`- 상태: ${b.status_summary}`);
            const s = display(b.summary_one_sentence, '');
            if (s) lines.push(`- ${s}`);
            lines.push('');
          });

          return scopedResult(lines.join('\n'));
        }

        // ── 목록 조회 ──────────────────────────────────────────
        let q = db
          .from('bill_topic_clusters')
          .select(CLUSTER_COLS, { count: 'exact' })
          .gte('total_bills', params.min_bills);

        if (params.keyword) {
          q = q.or(
            `cluster_name.ilike.%${params.keyword}%,primary_topic.ilike.%${params.keyword}%`
          );
        }
        if (params.domain) q = q.contains('domains', [params.domain]);

        const { data, error, count } = await q
          .order('total_bills', { ascending: false })
          .range(params.offset, params.offset + params.limit - 1);

        if (error) throw new Error(`법안군 조회에 실패했습니다: ${error.message}`);

        const clusters = (data ?? []) as ClusterRow[];
        const total = count ?? clusters.length;

        if (clusters.length === 0) {
          return textResult(
            `조건에 맞는 법안군이 없습니다.\n` +
              `keyword 를 더 일반적인 단어로 바꾸거나, min_bills 를 2로 낮추거나, domain 필터를 제거해 보세요.`
          );
        }

        if (params.response_format === 'json') {
          return scopedJson({
            ...buildPagination(total, clusters.length, params.offset),
            clusters,
          });
        }

        return scopedResult(
          renderWithLimit(clusters, (subset, note) => {
            const lines: string[] = ['# 법안 주제 클러스터', ''];
            lines.push(`전체 ${total}개 중 ${subset.length}개 표시 (offset ${params.offset})`, '');

            subset.forEach((c, i) => {
              lines.push(`### ${params.offset + i + 1}. ${cleanClusterName(c.cluster_name)} (${c.total_bills ?? 0}건)`);
              lines.push(`- 주제: ${display(c.primary_topic)}`);
              if (c.domains?.length) lines.push(`- 분야: ${c.domains.join(', ')}`);
              if (c.committees?.length) lines.push(`- 위원회: ${c.committees.slice(0, 3).join(', ')}`);
              lines.push(`- 상세: cluster_id="${c.cluster_id}"`);
              lines.push('');
            });

            if (total > params.offset + subset.length) {
              lines.push(`다음 페이지: offset=${params.offset + subset.length}`);
            }
            if (note) lines.push('', note);
            return lines.join('\n');
          })
        );
      })
  );
}
