import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDb, BILL_DETAIL_COLUMNS } from '@/services/supabase';
import {
  ResponseFormat,
  display,
  runTool,
  scopedJson,
  scopedResult,
  textResult,
} from '@/services/format';
import { SCOPE_NOTICE } from '@/constants';
import { fetchStatuses, renderStatusTimeline, statusToJson } from '@/services/status';
import { extractProposerNames } from '@/services/proposer';

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

interface LegislatorRow {
  name?: string | null;
  party?: string | null;
  district?: string | null;
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
  - 대표발의자와 소속 정당·지역구
  - **처리 상태**: 현재 심사단계, 소관위·법사위 심사일정과 결과, 본회의 의결, 공포일·공포번호
  - 같은 주제로 묶인 법안군(토픽 클러스터) ID

공동발의자는 제공하지 않는다: 국회 공개 데이터의 발의자 표기가 "홍길동의원 등 10인"
형식이라 나머지 인원의 이름이 원문에 존재하지 않는다. proposers.list 에는 대표발의자만
담기며, 드물게(전체 1%) 공동 대표발의인 경우 2명이 담긴다.

읽기 전용이며 데이터를 변경하지 않는다.

${SCOPE_NOTICE}

"이 법안 통과됐어?" "지금 어디까지 갔어?" 에 답할 수 있는 유일한 도구다. status 객체에 현재
심사단계와 소관위→법사위→본회의→공포 단계별 날짜·결과가 들어 있다. 값이 null 인 단계는
아직 도달하지 않은 것이지 정보 누락이 아니다.

언제 쓰나:
  - bills_search / bills_filter 로 후보를 찾은 뒤 특정 법안을 깊이 볼 때
  - "이 법안 누가 냈어?" "누구에게 영향이 가?" 같은 질문
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
    "primary": string | null,          // 대표발의자 (없으면 정부 제출 또는 위원장 발의)
    "total_count": number,             // 통상 1, 공동 대표발의면 2
    "list": [ { "name": string, "party": string | null,
                "region": string | null, "is_primary": true } ]
  },
  "topic_cluster_id": string | null,   // bills_topics 로 같은 주제 법안군 조회 가능
  "link_url": string,
  "status": {                          // 처리 상태. 상태 행을 못 찾으면 null
    "pass_gubn": "계류의안" | "처리의안" | null,
    "proc_stage_cd": string | null,    // 소관위심사 / 대안반영폐기 / 공포 등
    "current_committee": string | null,
    "committee_referral_date": string | null,   // 소관위 회부
    "committee_present_date": string | null,    // 소관위 상정
    "committee_proc_date": string | null,
    "committee_proc_result": string | null,
    "law_referral_date": string | null,         // 법사위 체계자구심사
    "law_present_date": string | null,
    "law_proc_date": string | null,
    "law_proc_result": string | null,
    "plenary_present_date": string | null,      // 본회의 부의
    "plenary_resolution_date": string | null,   // 본회의 의결일
    "plenary_conf_name": string | null,
    "plenary_result": string | null,            // 원안가결 / 수정가결 / 대안반영폐기 / 부결 등
    "govt_transfer_date": string | null,
    "promulgation_law_name": string | null,
    "promulgation_date": string | null,
    "promulgation_no": string | null,
    "has_reconsideration": boolean     // 재의요구(거부권) 후 재표결 기록 존재 여부
  },
  "data_scope": object                 // 출처·해석 주의사항
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

        // 발의자는 법안 레코드의 proposer 텍스트에서 직접 파싱한다.
        // 중간 테이블(bills_proposers)은 수동 동기화라 최신 법안이 비어 있다.
        const proposerNames = extractProposerNames(bill.proposer);

        let legislators: LegislatorRow[] = [];
        if (proposerNames.length > 0) {
          const { data: legRows } = await db
            .from('legislators')
            .select('name, party, district')
            .in('name', proposerNames);
          legislators = (legRows ?? []) as LegislatorRow[];
        }

        const metaByName = new Map(legislators.map((l) => [String(l.name), l]));
        const named = proposerNames.map((name) => {
          const meta = metaByName.get(name);
          return {
            name,
            party: meta?.party ?? null,
            region: meta?.district ?? null,
            is_primary: true, // 원문에 대표발의자만 표기됨
          };
        });
        const primary = named[0]?.name ?? null;

        // 의안번호가 재발급된 건이 있어 bill_id 를 폴백 키로 함께 넘긴다(services/status.ts).
        const statuses = await fetchStatuses([
          { bill_no: bill.bill_no as string | null, bill_id: bill.bill_id as string | null },
        ]);
        const status = statuses.get(String(bill.bill_no));

        const affected = bill.regulation_affected_groups;
        const affectedList = Array.isArray(affected) ? (affected as string[]) : null;

        if (params.response_format === 'json') {
          return scopedJson({
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
            status: statusToJson(status),
          });
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

        lines.push('## 발의자');
        if (named.length > 0) {
          for (const p of named) {
            const meta = [p.party, p.region].filter(Boolean).join(' · ');
            lines.push(`- **대표발의**: ${p.name}${meta ? ` (${meta})` : ''}`);
          }
          lines.push(`- 원문 표기: ${display(bill.proposer)}`);
          lines.push('- 공동발의자 명단은 원본 데이터에 포함되어 있지 않습니다.');
        } else {
          lines.push(`- ${display(bill.proposer)} (개인 의원 발의 아님 — 정부 제출 또는 위원회 대안)`);
        }
        lines.push('');

        if (bill.topic_cluster_id) {
          lines.push(
            `## 관련 법안군`,
            `같은 주제로 묶인 법안군이 있습니다. bills_topics 도구에 cluster_id="${bill.topic_cluster_id}" 로 조회하세요.`,
            ''
          );
        }
        // "이 법안 통과됐어?" 가 가장 자주 붙는 자리라 요약 바로 뒤가 아니라 여기에 둔다.
        lines.push(...renderStatusTimeline(status));

        if (bill.link_url) lines.push(`원문: ${bill.link_url}`);

        return scopedResult(lines.join('\n'));
      })
  );
}
