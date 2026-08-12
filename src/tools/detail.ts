import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDb, BILL_DETAIL_COLUMNS } from '@/services/supabase';
import { ResponseFormat, display, runTool, textResult } from '@/services/format';

const InputSchema = z
  .object({
    bill_no: z
      .string()
      .min(4)
      .max(20)
      .describe('의안번호. bills_search / bills_filter 결과의 bill_no 값. 예: "2209318"'),
    response_format: ResponseFormat,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface ProposerRow {
  member_name?: string | null;
  proposer_name?: string | null;
  member_party?: string | null;
  member_region?: string | null;
  is_primary?: boolean | null;
  order_seq?: number | null;
}

export function registerDetail(server: McpServer): void {
  server.registerTool(
    'bills_get',
    {
      title: '법안 상세 조회',
      description: `의안번호로 법안 1건의 전체 정보를 가져온다.

목록 도구가 주지 않는 상세 필드를 포함한다:
  - 4단계 요약: 한 줄 요약 / 쉬운 설명 / 왜 중요한가 / 누구에게 영향
  - 규제 영향 대상 집단
  - 공동발의자 전체 명단 (이름·정당·지역구)
  - 같은 주제로 묶인 법안군(토픽 클러스터) ID

읽기 전용이며 데이터를 변경하지 않는다.

언제 쓰나:
  - bills_search / bills_filter 로 후보를 찾은 뒤 특정 법안을 깊이 볼 때
  - "이 법안 누가 공동발의했어?" "누구에게 영향이 가?" 같은 질문
  - 여러 법안을 훑어보려면 목록 도구를 쓴다 (이 도구는 1건씩만 조회)

반환값 (response_format="json"):
{
  "bill_no": string,
  "bill_name": string,
  "proposal_date": string,
  "committee": string | null,
  "domain": string,
  "regulation_type": string | null,
  "regulation_affected_groups": string[] | null,
  "summary": {
    "one_sentence": string,
    "easy_explanation": string,
    "why_important": string,
    "who_affected": string
  },
  "proposers": {
    "primary": string | null,          // 대표발의자
    "total_count": number,
    "list": [ { "name": string, "party": string | null,
                "region": string | null, "is_primary": boolean } ]
  },
  "topic_cluster_id": string | null,   // bills_topics 로 같은 주제 법안군 조회 가능
  "link_url": string
}

오류 대응:
  - "법안을 찾을 수 없습니다" → 의안번호 오타이거나 수록 범위(2024-05-30 이후) 밖이다.
    bills_filter 의 keyword 로 법안명 일부를 검색해 정확한 의안번호를 먼저 확인할 것`,
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

        const { data: bills, error } = await db
          .from('bills_monitor_bills')
          .select(BILL_DETAIL_COLUMNS)
          .eq('bill_no', params.bill_no)
          .limit(1);

        if (error) throw new Error(`법안 조회에 실패했습니다: ${error.message}`);

        const bill = bills?.[0] as Record<string, unknown> | undefined;
        if (!bill) {
          return textResult(
            `의안번호 "${params.bill_no}" 법안을 찾을 수 없습니다.\n` +
              `의안번호를 확인하거나, bills_filter 의 keyword 로 법안명 일부를 검색해 정확한 번호를 찾으세요. ` +
              `이 서버는 2024-05-30 이후 발의 법안만 수록합니다.`
          );
        }

        const { data: proposerRows } = await db
          .from('bills_proposers')
          .select('member_name, proposer_name, member_party, member_region, is_primary, order_seq')
          .eq('bill_uuid', bill.id as string)
          .order('order_seq', { ascending: true });

        const proposers = (proposerRows ?? []) as ProposerRow[];
        const named = proposers.map((p) => ({
          name: display(p.member_name ?? p.proposer_name, '이름 미상'),
          party: p.member_party ?? null,
          region: p.member_region ?? null,
          is_primary: Boolean(p.is_primary),
        }));
        const primary = named.find((p) => p.is_primary)?.name ?? null;

        const affected = bill.regulation_affected_groups;
        const affectedList = Array.isArray(affected) ? (affected as string[]) : null;

        if (params.response_format === 'json') {
          return textResult(
            JSON.stringify(
              {
                bill_no: bill.bill_no,
                bill_name: bill.bill_name,
                proposal_date: bill.proposal_date,
                committee: bill.committee ?? null,
                domain: bill.domain ?? null,
                regulation_type: bill.regulation_type ?? null,
                regulation_affected_groups: affectedList,
                summary: {
                  one_sentence: bill.summary_one_sentence ?? null,
                  easy_explanation: bill.summary_easy_explanation ?? null,
                  why_important: bill.summary_why_important ?? null,
                  who_affected: bill.summary_who_affected ?? null,
                },
                proposers: { primary, total_count: named.length, list: named },
                topic_cluster_id: bill.topic_cluster_id ?? null,
                link_url: bill.link_url ?? null,
              },
              null,
              2
            )
          );
        }

        const lines: string[] = [];
        lines.push(`# ${display(bill.bill_name)}`, '');
        lines.push(
          `의안번호 ${display(bill.bill_no)} · 발의일 ${display(bill.proposal_date)} · ` +
            `${display(bill.committee, '소관위 미지정')}`
        );
        lines.push(`분야 ${display(bill.domain)} · 규제 ${display(bill.regulation_type, '미분류')}`);
        lines.push('');

        lines.push('## 요약');
        lines.push(`**한 줄 요약**: ${display(bill.summary_one_sentence)}`, '');
        lines.push(`**쉬운 설명**: ${display(bill.summary_easy_explanation)}`, '');
        lines.push(`**왜 중요한가**: ${display(bill.summary_why_important)}`, '');
        lines.push(`**영향 대상**: ${display(bill.summary_who_affected)}`, '');

        if (affectedList?.length) {
          lines.push(`**규제 영향 집단**: ${affectedList.join(', ')}`, '');
        }

        lines.push(`## 발의자 (총 ${named.length}명)`);
        if (primary) lines.push(`- **대표발의**: ${primary}`);
        const co = named.filter((p) => !p.is_primary);
        if (co.length) {
          lines.push(
            `- 공동발의: ${co
              .map((p) => (p.party ? `${p.name}(${p.party})` : p.name))
              .join(', ')}`
          );
        }
        if (named.length === 0) lines.push(`- 원문 표기: ${display(bill.proposer)}`);
        lines.push('');

        if (bill.topic_cluster_id) {
          lines.push(
            `## 관련 법안군`,
            `같은 주제로 묶인 법안군이 있습니다. bills_topics 도구에 cluster_id="${bill.topic_cluster_id}" 로 조회하세요.`,
            ''
          );
        }
        if (bill.link_url) lines.push(`원문: ${bill.link_url}`);

        return textResult(lines.join('\n'));
      })
  );
}
