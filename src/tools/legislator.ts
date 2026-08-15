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
import { SCOPE_NOTICE } from '@/constants';
import { limitField, offsetField, stripInternalIds } from '@/services/bills';
import { extractProposerNames, proposerLikePattern } from '@/services/proposer';
import { attachStatusSummaries } from '@/services/status';

const PARTIES = [
  '더불어민주당',
  '국민의힘',
  '조국혁신당',
  '개혁신당',
  '진보당',
  '기본소득당',
  '사회민주당',
  '무소속',
] as const;

/** 정당 조회 시 스캔할 최대 법안 수 (기간을 좁히도록 유도) */
const MAX_PARTY_SCAN = 3000;
const PAGE = 1000;
/** 정당 조회에 기간이 없을 때 적용하는 기본 조회 창 (일) */
const DEFAULT_PARTY_WINDOW_DAYS = 90;

// bill_id 는 응답에 싣지 않고 처리 상태 조인 폴백 키로만 쓴다(services/status.ts).
const BILL_COLS =
  'bill_id, bill_no, bill_name, proposer, proposal_date, committee, domain, regulation_type, summary_one_sentence, link_url';

const InputSchema = z
  .object({
    member_name: z
      .string()
      .min(2)
      .max(20)
      .optional()
      .describe('의원 이름 (정확 일치). 예: "이해식". member_name 과 party 중 최소 하나는 필요하다'),
    party: z
      .enum(PARTIES)
      .optional()
      .describe('정당명. 지정하면 해당 정당 소속 의원들이 대표발의한 법안을 모은다'),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다')
      .optional()
      .describe('발의일 시작(포함). 예: "2026-01-01"'),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다')
      .optional()
      .describe('발의일 종료(포함)'),
    limit: limitField,
    offset: offsetField,
    response_format: ResponseFormat,
  })
  .strict()
  .refine((v) => Boolean(v.member_name || v.party), {
    message: 'member_name 또는 party 중 최소 하나를 지정해야 합니다',
  });

type Input = z.infer<typeof InputSchema>;

interface BillRow {
  /** 응답에는 싣지 않는다. 처리 상태 조인 폴백 키 전용 (stripInternalIds 가 제거) */
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
  status_summary?: string;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function registerLegislator(server: McpServer): void {
  server.registerTool(
    'bills_by_legislator',
    {
      title: '의원·정당별 대표발의 법안',
      description: `특정 국회의원 또는 정당이 **대표발의**한 법안을 조회한다 (제22대 국회).

읽기 전용이며 데이터를 변경하지 않는다.

${SCOPE_NOTICE}
각 법안에 처리 상태 요약(status_summary)이 붙으므로 "이 의원 법안 중 통과된 건?"을 결과에서
세어 볼 수는 있다. 다만 **반환 건수 자체는 발의 건수**이고, 가결률을 의원의 성과로 제시하지 말 것.
법안 대부분은 위원회 대안에 흡수(대안반영폐기)되는 경로를 밟는데 이는 실패가 아니다.

언제 쓰나:
  - "이해식 의원이 낸 법안" → member_name="이해식"
  - "조국혁신당이 올해 대표발의한 법안" → party="조국혁신당", date_from="2026-01-01"
  - 주제로 찾으려면 bills_search, 위원회·분야로 찾으려면 bills_filter 를 쓴다

중요 — 공동발의는 조회할 수 없다:
  국회 공개 데이터의 발의자 표기가 "이해식의원 등 10인" 형식이라 나머지 9명의 이름이
  원문에 존재하지 않는다. 따라서 이 도구는 **대표발의자만** 반환한다.
  "A 의원이 공동발의에 참여했는가"는 이 데이터로 답할 수 없으므로, 그렇게 물으면
  대표발의 기준 결과임을 명확히 밝혀야 한다.
  드물게(전체 1%) "권영진의원ㆍ복기왕의원 등 10인" 같은 공동 대표발의가 있으며 두 명 모두 매칭된다.

정당 목록: ${PARTIES.join(', ')}

정당 조회 시 기간:
  기간을 지정하지 않으면 최근 ${DEFAULT_PARTY_WINDOW_DAYS}일로 자동 제한하며 응답에 명시한다.
  기간 내 법안이 ${MAX_PARTY_SCAN.toLocaleString()}건을 넘으면 범위를 좁히도록 안내한다.

반환값 (response_format="json"):
{
  "subject": string,        // 조회 대상 (의원명 또는 정당명)
  "basis": "대표발의",
  "period": string | null,  // 자동 적용된 기간이 있으면 표시
  "total": number,
  "count": number,
  "offset": number,
  "bills": [ { "bill_no", "bill_name", "proposer", "proposal_date",
               "committee", "domain", "regulation_type",
               "summary_one_sentence", "link_url" } ],
  "has_more": boolean,
  "next_offset": number
}

오류 대응:
  - 결과 0건 → 이름 표기를 확인한다(한자 병기·띄어쓰기 없음). 정부 제출·위원장 발의 법안은
    개인 의원이 없어 애초에 잡히지 않는다
  - member_name 과 party 를 모두 생략하면 검증 오류가 난다`,
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
        const subject = params.member_name ?? params.party ?? '';

        // ── 의원 단위: proposer 텍스트를 직접 조회 (항상 최신, DB 페이지네이션) ──
        if (params.member_name) {
          let q = db
            .from('bills_monitor_bills')
            .select(BILL_COLS, { count: 'exact' })
            .ilike('proposer', proposerLikePattern(params.member_name));

          if (params.date_from) q = q.gte('proposal_date', params.date_from);
          if (params.date_to) q = q.lte('proposal_date', params.date_to);

          const { data, error, count } = await q
            .order('proposal_date', { ascending: false })
            .range(params.offset, params.offset + params.limit - 1);

          if (error) throw new Error(`법안 조회에 실패했습니다: ${error.message}`);

          const bills = (data ?? []) as BillRow[];
          const total = count ?? bills.length;

          if (bills.length === 0) {
            return textResult(
              `"${subject}" 의원이 대표발의한 법안을 찾을 수 없습니다.\n` +
                `이름 표기를 확인하거나 기간 조건을 넓혀 보세요. ` +
                `이 도구는 대표발의만 조회하며, 정부 제출·위원장 발의 법안에는 개인 의원이 없습니다.`
            );
          }

          const meta = await memberMeta(db, params.member_name);
          return await formatOutput(params, subject, bills, total, meta, null);
        }

        // ── 정당 단위: 기간으로 범위를 묶고 소속 의원 이름으로 앱에서 필터 ──
        const partyName = params.party as string;
        const autoFrom = params.date_from ?? daysAgo(DEFAULT_PARTY_WINDOW_DAYS);
        const periodNote = params.date_from
          ? null
          : `기간 미지정이라 최근 ${DEFAULT_PARTY_WINDOW_DAYS}일(${autoFrom} 이후)로 제한했습니다.`;

        const { data: memberRows, error: mErr } = await db
          .from('legislators')
          .select('name')
          .eq('party', partyName);
        if (mErr) throw new Error(`의원 명단 조회에 실패했습니다: ${mErr.message}`);

        const memberNames = new Set(
          (memberRows ?? []).map((r) => String(r.name ?? '')).filter(Boolean)
        );
        if (memberNames.size === 0) {
          return textResult(`"${partyName}" 소속 의원을 찾을 수 없습니다. 정당명을 확인하세요.`);
        }

        let countQuery = db
          .from('bills_monitor_bills')
          .select('bill_no', { count: 'exact', head: true })
          .gte('proposal_date', autoFrom);
        if (params.date_to) countQuery = countQuery.lte('proposal_date', params.date_to);

        const { count: scanCount, error: cErr } = await countQuery;
        if (cErr) throw new Error(`기간 조회에 실패했습니다: ${cErr.message}`);

        const inRange = scanCount ?? 0;
        if (inRange > MAX_PARTY_SCAN) {
          return textResult(
            `지정한 기간에 발의된 법안이 ${inRange.toLocaleString()}건으로 한 번에 처리할 수 있는 ` +
              `범위(${MAX_PARTY_SCAN.toLocaleString()}건)를 넘습니다.\n` +
              `date_from/date_to 로 기간을 좁히거나, 특정 의원을 member_name 으로 지정하세요.\n` +
              `정당별 분포만 필요하면 bills_statistics 를 사용하세요.`
          );
        }

        const scanned: BillRow[] = [];
        for (let from = 0; from < inRange; from += PAGE) {
          let pq = db
            .from('bills_monitor_bills')
            .select(BILL_COLS)
            .gte('proposal_date', autoFrom);
          if (params.date_to) pq = pq.lte('proposal_date', params.date_to);

          const { data: chunk, error: pErr } = await pq
            .order('proposal_date', { ascending: false })
            .range(from, Math.min(from + PAGE, inRange) - 1);
          if (pErr) throw new Error(`법안 조회에 실패했습니다: ${pErr.message}`);
          scanned.push(...((chunk ?? []) as BillRow[]));
        }

        const matched = scanned.filter((b) =>
          extractProposerNames(b.proposer).some((n) => memberNames.has(n))
        );

        if (matched.length === 0) {
          return textResult(
            `"${partyName}" 소속 의원이 대표발의한 법안이 해당 기간에 없습니다.` +
              (periodNote ? `\n${periodNote} 기간을 넓혀 보세요.` : '')
          );
        }

        const page = matched.slice(params.offset, params.offset + params.limit);
        return await formatOutput(params, partyName, page, matched.length, null, periodNote);
      })
  );
}

/** 의원 1명의 정당·지역구 정보 (표시용) */
async function memberMeta(
  db: ReturnType<typeof getDb>,
  name: string
): Promise<{ party: string | null; district: string | null } | null> {
  const { data } = await db
    .from('legislators')
    .select('party, district')
    .eq('name', name)
    .limit(1);

  const row = data?.[0];
  return row ? { party: row.party ?? null, district: row.district ?? null } : null;
}

async function formatOutput(
  params: Input,
  subject: string,
  bills: BillRow[],
  total: number,
  meta: { party: string | null; district: string | null } | null,
  periodNote: string | null
) {
  await attachStatusSummaries(bills);

  if (params.response_format === 'json') {
    return scopedJson({
      subject,
      basis: '대표발의',
      ...(meta ? { party: meta.party, district: meta.district } : {}),
      ...(periodNote ? { period: periodNote } : {}),
      ...buildPagination(total, bills.length, params.offset),
      bills: stripInternalIds(bills),
    });
  }

  return scopedResult(
    renderWithLimit(bills, (subset, note) => {
      const lines: string[] = [`# ${subject} — 대표발의 법안`, ''];
      if (meta?.party) {
        lines.push(`${meta.party}${meta.district ? ` · ${meta.district}` : ''}`);
      }
      lines.push(`전체 ${total.toLocaleString()}건 중 ${subset.length}건 표시 (offset ${params.offset})`);
      if (periodNote) lines.push(periodNote);
      lines.push('');

      subset.forEach((b, i) => {
        lines.push(`### ${params.offset + i + 1}. ${display(b.bill_name)}`);
        lines.push(`- 의안번호 ${display(b.bill_no)} · ${display(b.proposal_date)} · ${display(b.proposer)}`);
        lines.push(
          `- ${display(b.committee, '소관위 미지정')} · ${display(b.domain)} · 규제 ${display(b.regulation_type, '미분류')}`
        );
        if (b.status_summary) lines.push(`- 상태: ${b.status_summary}`);
        const s = display(b.summary_one_sentence, '');
        if (s) lines.push(`- ${s}`);
        lines.push('');
      });

      if (total > params.offset + subset.length) {
        lines.push(`다음 페이지: offset=${params.offset + subset.length}`);
      }
      if (note) lines.push('', note);
      return lines.join('\n');
    })
  );
}
