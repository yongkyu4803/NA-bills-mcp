import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDb, fetchBillsByIds } from '@/services/supabase';
import {
  ResponseFormat,
  buildPagination,
  display,
  renderWithLimit,
  runTool,
  textResult,
} from '@/services/format';
import { limitField, offsetField, stripInternalIds } from '@/services/bills';

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

const InputSchema = z
  .object({
    member_name: z
      .string()
      .min(2)
      .max(20)
      .optional()
      .describe('의원 이름 (정확 일치). 예: "박용규". member_name 과 party 중 최소 하나는 필요하다'),
    party: z
      .enum(PARTIES)
      .optional()
      .describe('정당명. member_name 없이 지정하면 해당 정당 소속 의원들의 대표발의 법안을 모은다'),
    role: z
      .enum(['primary', 'any'])
      .default('primary')
      .describe(
        "'primary'는 대표발의만(기본), 'any'는 공동발의 포함. 발의 '주도' 여부를 보려면 primary 를 쓴다"
      ),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('발의일 시작(포함). 예: "2026-01-01"'),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
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

/** 발의자 행을 한 번에 처리할 수 있는 상한 (초과 시 범위 축소를 안내) */
const MAX_PROPOSER_SCAN = 2000;
const PROPOSER_PAGE = 1000;
/** 기간 조건으로 좁힐 때 허용하는 최대 법안 수 */
const MAX_DATE_SCAN = 3000;

interface LegislatorBillRow {
  id?: string;
  bill_no?: string | null;
  bill_name?: string | null;
  proposal_date?: string | null;
  committee?: string | null;
  domain?: string | null;
  regulation_type?: string | null;
  summary_one_sentence?: string | null;
  link_url?: string | null;
}

interface ProposerJoinRow {
  bill_uuid: string;
  member_name: string | null;
  member_party: string | null;
  member_region: string | null;
  is_primary: boolean | null;
}

/**
 * bills_proposers 는 법안 테이블보다 갱신이 늦어 최근 발의분에는 발의자 기록이 없다.
 * 빈 결과가 "그런 의원이 없어서"인지 "데이터가 아직 연결되지 않아서"인지 구분할 수 있게 안내한다.
 *
 * 정확한 수록 한계일을 구하려면 두 테이블을 조인해야 하는데 FK 가 없어 저렴하게 얻을 수 없다.
 * 부정확한 날짜를 단정하기보다 한계의 성격만 알려준다.
 */
function coverageNote(): string {
  return (
    '참고: 발의자(의원) 정보는 법안 데이터보다 갱신이 늦어, 최근 발의된 법안에는 ' +
    '아직 의원 정보가 연결되지 않았을 수 있습니다. 그런 경우 bills_filter 로 조회하세요.'
  );
}

export function registerLegislator(server: McpServer): void {
  server.registerTool(
    'bills_by_legislator',
    {
      title: '의원·정당별 발의 법안',
      description: `특정 국회의원 또는 정당이 발의한 법안 목록을 조회한다 (제22대 국회, 의원 294명 / 8개 정당).

대표발의(primary)와 공동발의(any)를 구분할 수 있어 "누가 실제로 법안을 주도했는가"를 볼 수 있다.
읽기 전용이며 데이터를 변경하지 않는다.

언제 쓰나:
  - "홍길동 의원이 낸 법안" → member_name="홍길동"
  - "조국혁신당이 올해 대표발의한 법안" → party="조국혁신당", date_from="2026-01-01"
  - "이 의원이 공동발의까지 참여한 전체" → member_name="홍길동", role="any"
  - 주제로 찾으려면 bills_search, 위원회·분야로 찾으려면 bills_filter 를 쓴다

정당 목록: ${PARTIES.join(', ')}

반환값 (response_format="json"):
{
  "subject": string,          // 조회 대상 (의원명 또는 정당명)
  "role": "primary" | "any",
  "total": number,
  "count": number,
  "offset": number,
  "bills": [ { "bill_no", "bill_name", "proposal_date", "committee",
               "domain", "regulation_type", "summary_one_sentence",
               "proposer_name", "party", "is_primary" } ],
  "has_more": boolean,
  "next_offset": number
}

오류 대응:
  - 결과 0건 → 이름 표기를 확인한다(동명이인·한자 병기 없음). 정당만으로 넓게 조회한 뒤 이름을 확인하는 방법도 있다
  - member_name 과 party 를 모두 생략하면 검증 오류가 난다
  - "처리할 수 있는 범위를 넘습니다" → 대상이 2000건을 넘었다. 기간을 좁히거나 특정 의원을 지정하거나,
    분포만 필요하면 bills_statistics 를 쓴다 (거대 정당 전체 조회 시 발생)

데이터 한계 (중요):
  - 발의자(의원) 정보는 법안 데이터보다 갱신이 늦다. 최근 몇 달간 발의된 법안에는 의원 정보가
    아직 연결되지 않아 이 도구로는 조회되지 않는다. 최신 법안은 bills_filter 를 쓸 것
  - 발의자 기록 중 일부는 대응하는 법안 레코드가 없어, 발의 건수와 실제 반환 법안 수가 소폭 다를 수 있다`,
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
        const who = params.member_name ?? params.party ?? '';
        const roleText = params.role === 'primary' ? '대표발의' : '대표+공동발의';

        // bills_proposers 에는 발의일이 없고 두 테이블 사이에 FK 도 없어 PostgREST 임베딩을 쓸 수 없다.
        // 기간 조건이 있으면 법안을 먼저 좁힌 뒤 그 id 로 발의자를 조회해야 상한에 걸리지 않는다.
        const baseProposerQuery = () => {
          let q = db
            .from('bills_proposers')
            .select('bill_uuid, member_name, member_party, member_region, is_primary', {
              count: 'exact',
            });
          if (params.member_name) q = q.eq('member_name', params.member_name);
          if (params.party) q = q.eq('member_party', params.party);
          if (params.role === 'primary') q = q.eq('is_primary', true);
          return q;
        };

        const { count: proposerCount, error: countErr } = await baseProposerQuery().range(0, 0);
        if (countErr) throw new Error(`발의자 조회에 실패했습니다: ${countErr.message}`);
        const matchCount = proposerCount ?? 0;

        if (matchCount === 0) {
          return textResult(
            `"${who}"의 ${roleText} 기록을 찾을 수 없습니다.\n` +
              `이름 표기를 확인하거나, role="any" 로 공동발의까지 포함해 보세요.\n` +
              `${coverageNote()}`
          );
        }

        // 발의자 수가 적으면(대부분의 의원 단위 조회) 발의자를 먼저 읽는 편이 훨씬 싸다.
        // 정당 단위처럼 발의자가 많을 때만 기간으로 법안을 먼저 좁힌다.
        const hasDateFilter = Boolean(params.date_from || params.date_to);
        const needDateFirst = matchCount > MAX_PROPOSER_SCAN;
        let billIdsInRange: string[] | null = null;

        if (needDateFirst && !hasDateFilter) {
          return textResult(
            `"${who}"의 ${roleText} 건수가 ${matchCount.toLocaleString()}건으로 ` +
              `한 번에 처리할 수 있는 범위(${MAX_PROPOSER_SCAN.toLocaleString()}건)를 넘습니다.\n` +
              `date_from/date_to 로 기간을 좁히거나, party 대신 member_name 으로 특정 의원을 지정하세요.\n` +
              `정당 전체의 분포만 필요하다면 bills_statistics 를 사용하세요.`
          );
        }

        if (needDateFirst) {
          let dq = db.from('bills_monitor_bills').select('id', { count: 'exact' });
          if (params.date_from) dq = dq.gte('proposal_date', params.date_from);
          if (params.date_to) dq = dq.lte('proposal_date', params.date_to);

          const { count: rangeCount, error: rErr } = await dq.range(0, 0);
          if (rErr) throw new Error(`기간 조회에 실패했습니다: ${rErr.message}`);

          const inRange = rangeCount ?? 0;
          if (inRange > MAX_DATE_SCAN) {
            return textResult(
              `지정한 기간에 발의된 법안이 ${inRange.toLocaleString()}건으로 한 번에 처리할 수 있는 ` +
                `범위(${MAX_DATE_SCAN.toLocaleString()}건)를 넘습니다.\n기간을 더 좁혀 주세요.`
            );
          }

          billIdsInRange = [];
          for (let from = 0; from < inRange; from += PROPOSER_PAGE) {
            let cq = db.from('bills_monitor_bills').select('id');
            if (params.date_from) cq = cq.gte('proposal_date', params.date_from);
            if (params.date_to) cq = cq.lte('proposal_date', params.date_to);

            const { data: idRows, error: idErr } = await cq.range(
              from,
              Math.min(from + PROPOSER_PAGE, inRange) - 1
            );
            if (idErr) throw new Error(`기간 조회에 실패했습니다: ${idErr.message}`);
            billIdsInRange.push(...(idRows ?? []).map((r) => r.id as string));
          }

          if (billIdsInRange.length === 0) {
            return textResult('지정한 기간에 발의된 법안이 없습니다. 기간을 넓혀 보세요.');
          }
        }

        const rows: ProposerJoinRow[] = [];

        if (billIdsInRange) {
          // 기간으로 좁힌 법안 id 로 발의자를 배치 조회
          const chunks: string[][] = [];
          for (let i = 0; i < billIdsInRange.length; i += 150) {
            chunks.push(billIdsInRange.slice(i, i + 150));
          }
          const parts = await Promise.all(
            chunks.map(async (chunk) => {
              const { data, error } = await baseProposerQuery().in('bill_uuid', chunk);
              if (error) throw new Error(`발의자 조회에 실패했습니다: ${error.message}`);
              return (data ?? []) as ProposerJoinRow[];
            })
          );
          for (const p of parts) rows.push(...p);
        } else {
          for (let from = 0; from < matchCount; from += PROPOSER_PAGE) {
            const { data: chunk, error: chunkErr } = await baseProposerQuery().range(
              from,
              Math.min(from + PROPOSER_PAGE, matchCount) - 1
            );
            if (chunkErr) throw new Error(`발의자 조회에 실패했습니다: ${chunkErr.message}`);
            rows.push(...((chunk ?? []) as ProposerJoinRow[]));
          }
        }
        if (rows.length === 0) {
          return textResult(
            `"${who}"의 발의 법안을 찾을 수 없습니다.\n` +
              `이름 표기를 확인하거나, role="any" 로 공동발의까지 포함해 보세요. ` +
              `정당만으로 먼저 조회해 정확한 이름을 확인할 수도 있습니다.`
          );
        }

        const byBillUuid = new Map(rows.map((r) => [r.bill_uuid, r]));

        // id 가 수백 개가 될 수 있어 배치 조회한다 (URL 길이 제한 회피)
        let billRows: LegislatorBillRow[];
        try {
          billRows = await fetchBillsByIds<LegislatorBillRow>(
            [...byBillUuid.keys()],
            'id, bill_no, bill_name, proposal_date, committee, domain, regulation_type, summary_one_sentence, link_url',
            (q) => {
              let b = q;
              if (params.date_from) b = b.gte('proposal_date', params.date_from);
              if (params.date_to) b = b.lte('proposal_date', params.date_to);
              return b;
            }
          );
        } catch (e) {
          throw new Error(`법안 조회에 실패했습니다: ${e instanceof Error ? e.message : String(e)}`);
        }

        billRows.sort((a, b) =>
          String(b.proposal_date ?? '').localeCompare(String(a.proposal_date ?? ''))
        );

        const all = billRows.map((b) => {
          const p = byBillUuid.get(b.id ?? '');
          return {
            ...b,
            proposer_name: p?.member_name ?? null,
            party: p?.member_party ?? null,
            is_primary: Boolean(p?.is_primary),
          };
        });

        const total = all.length;
        const page = all.slice(params.offset, params.offset + params.limit);
        const subject = params.member_name ?? params.party ?? '';
        const roleLabel = params.role === 'primary' ? '대표발의' : '대표+공동발의';

        if (page.length === 0) {
          return textResult(
            `"${subject}"의 ${roleLabel} 법안이 지정한 기간에는 없습니다.\n` +
              `기간 조건을 넓혀 보세요. ${coverageNote()}`
          );
        }

        if (params.response_format === 'json') {
          return textResult(
            JSON.stringify(
              {
                subject,
                role: params.role,
                ...buildPagination(total, page.length, params.offset),
                bills: stripInternalIds(page),
              },
              null,
              2
            )
          );
        }

        return textResult(
          renderWithLimit(page, (subset, note) => {
            const lines: string[] = [`# ${subject} — ${roleLabel} 법안`, ''];
            const partyInfo = rows[0]?.member_party;
            const regionInfo = rows[0]?.member_region;
            if (params.member_name && partyInfo) {
              lines.push(`${partyInfo}${regionInfo ? ` · ${regionInfo}` : ''}`);
            }
            lines.push(`전체 ${total.toLocaleString()}건 중 ${subset.length}건 표시 (offset ${params.offset})`, '');

            subset.forEach((b, i) => {
              lines.push(`### ${params.offset + i + 1}. ${display(b.bill_name)}`);
              lines.push(
                `- 의안번호 ${display(b.bill_no)} · ${display(b.proposal_date)} · ` +
                  `${b.is_primary ? '대표발의' : '공동발의'}`
              );
              lines.push(
                `- ${display(b.committee, '소관위 미지정')} · ${display(b.domain)} · 규제 ${display(b.regulation_type, '미분류')}`
              );
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
      })
  );
}
