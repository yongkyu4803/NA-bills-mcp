import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getDb } from '@/services/supabase';
import {
  ResponseFormat,
  buildPagination,
  display,
  renderWithLimit,
  runTool,
  textResult,
} from '@/services/format';
import { limitField, offsetField } from '@/services/bills';

const InputSchema = z
  .object({
    report_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다')
      .optional()
      .describe('특정 날짜의 리포트를 조회. 생략하면 목록 모드로 동작한다. 예: "2026-08-11"'),
    latest: z
      .boolean()
      .default(false)
      .describe('true 면 가장 최근 리포트 1건의 전문을 반환한다 (report_date 보다 우선)'),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('목록 모드에서 조회 시작일'),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('목록 모드에서 조회 종료일'),
    limit: limitField,
    offset: offsetField,
    response_format: ResponseFormat,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

interface ReportRow {
  slug: string | null;
  report_date: string | null;
  headline: string | null;
  overview: string | null;
  key_trends: unknown;
  statistics: unknown;
  total_bills: number | null;
  analyzed_bills: number | null;
  filtered_bills: number | null;
}

const REPORT_COLS =
  'slug, report_date, headline, overview, key_trends, statistics, total_bills, analyzed_bills, filtered_bills';

export function registerReports(server: McpServer): void {
  server.registerTool(
    'bills_daily_report',
    {
      title: '일일 법안 동향 리포트',
      description: `국회 일일 법안 발의 동향을 정리한 편집 리포트를 조회한다 (약 500건 수록).

각 리포트는 그날 발의된 법안들을 훑어 헤드라인·총평·핵심 흐름(key_trends)·통계를 담고 있다.
개별 법안 데이터가 아니라 "그날 무슨 일이 있었는가"에 대한 서술형 정리다.
읽기 전용이며 데이터를 변경하지 않는다.

세 가지 사용법:
  1) 최신 리포트 전문 — latest=true
  2) 특정일 리포트 전문 — report_date="2026-08-11"
  3) 기간별 목록 — date_from/date_to (또는 인자 없이 최근 목록)

언제 쓰나:
  - "최근 국회 법안 동향 알려줘" → latest=true
  - "지난주에 어떤 흐름이 있었어?" → date_from/date_to 로 목록을 본 뒤 관심 날짜를 전문 조회
  - 특정 주제·법안을 찾는 것이 목적이면 bills_search 나 bills_filter 를 쓴다

반환값 — 전문 조회 (response_format="json"):
{
  "report_date": string,
  "headline": string,
  "overview": string,
  "key_trends": unknown,        // 리포트마다 구조가 다른 JSON
  "statistics": unknown,
  "counts": { "total": number, "analyzed": number, "filtered": number }
}

반환값 — 목록 조회:
{
  "total": number, "count": number, "offset": number,
  "reports": [ { "report_date", "headline", "total_bills" } ],
  "has_more": boolean
}

오류 대응:
  - 해당 날짜 리포트 없음 → 주말·공휴일에는 리포트가 없을 수 있다. 목록 모드로 실제 존재하는 날짜를 먼저 확인할 것`,
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
        const wantsSingle = params.latest || Boolean(params.report_date);

        // ── 전문 조회 ──────────────────────────────────────────
        if (wantsSingle) {
          let q = db.from('bills_monitor_reports').select(REPORT_COLS);

          if (params.latest) {
            q = q.order('report_date', { ascending: false }).limit(1);
          } else {
            q = q.eq('report_date', params.report_date as string).limit(1);
          }

          const { data, error } = await q;
          if (error) throw new Error(`리포트 조회에 실패했습니다: ${error.message}`);

          const report = data?.[0] as ReportRow | undefined;
          if (!report) {
            return textResult(
              `${params.report_date ?? '최신'} 리포트를 찾을 수 없습니다.\n` +
                `주말·공휴일에는 리포트가 없을 수 있습니다. report_date 없이 호출해 존재하는 날짜 목록을 먼저 확인하세요.`
            );
          }

          if (params.response_format === 'json') {
            return textResult(
              JSON.stringify(
                {
                  report_date: report.report_date,
                  headline: report.headline,
                  overview: report.overview,
                  key_trends: report.key_trends ?? null,
                  statistics: report.statistics ?? null,
                  counts: {
                    total: report.total_bills ?? 0,
                    analyzed: report.analyzed_bills ?? 0,
                    filtered: report.filtered_bills ?? 0,
                  },
                },
                null,
                2
              )
            );
          }

          const lines: string[] = [];
          lines.push(`# ${display(report.headline, '국회 법안 동향')}`, '');
          lines.push(`${display(report.report_date)} · 발의 ${report.total_bills ?? 0}건 (분석 ${report.analyzed_bills ?? 0}건)`, '');

          const overview = display(report.overview, '');
          if (overview) lines.push('## 총평', overview, '');

          const trends = report.key_trends;
          if (Array.isArray(trends) && trends.length > 0) {
            lines.push('## 핵심 흐름');
            trends.forEach((t, i) => {
              if (t && typeof t === 'object') {
                const o = t as Record<string, unknown>;
                const title = display(o.title ?? o.name ?? o.trend, `흐름 ${i + 1}`);
                lines.push(`### ${i + 1}. ${title}`);
                const body = display(o.description ?? o.summary ?? o.detail, '');
                if (body) lines.push(body);
              } else {
                lines.push(`- ${String(t)}`);
              }
              lines.push('');
            });
          }

          return textResult(lines.join('\n'));
        }

        // ── 목록 조회 ──────────────────────────────────────────
        let q = db
          .from('bills_monitor_reports')
          .select('report_date, headline, total_bills', { count: 'exact' });

        if (params.date_from) q = q.gte('report_date', params.date_from);
        if (params.date_to) q = q.lte('report_date', params.date_to);

        const { data, error, count } = await q
          .order('report_date', { ascending: false })
          .range(params.offset, params.offset + params.limit - 1);

        if (error) throw new Error(`리포트 목록 조회에 실패했습니다: ${error.message}`);

        const reports = (data ?? []) as Array<{
          report_date: string | null;
          headline: string | null;
          total_bills: number | null;
        }>;
        const total = count ?? reports.length;

        if (reports.length === 0) {
          return textResult('해당 기간에 리포트가 없습니다. 기간을 넓히거나 인자 없이 호출해 최근 목록을 확인하세요.');
        }

        if (params.response_format === 'json') {
          return textResult(
            JSON.stringify(
              { ...buildPagination(total, reports.length, params.offset), reports },
              null,
              2
            )
          );
        }

        return textResult(
          renderWithLimit(reports, (subset, note) => {
            const lines: string[] = ['# 일일 법안 동향 리포트 목록', ''];
            lines.push(`전체 ${total}건 중 ${subset.length}건 표시 (offset ${params.offset})`, '');
            for (const r of subset) {
              lines.push(
                `- **${display(r.report_date)}** (${r.total_bills ?? 0}건) — ${display(r.headline, '제목 없음')}`
              );
            }
            lines.push('', '전문을 보려면 report_date 를 지정해 다시 호출하세요.');
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
