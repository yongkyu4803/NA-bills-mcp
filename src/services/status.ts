/**
 * 법안 처리 상태 조회 (bills_status).
 *
 * bills_status 는 daily-bills 파이프라인이 국회 ALLBILLV2 를 일 1회 미러링하는 테이블이다.
 * 이 저장소는 읽기만 한다(anon 키에 SELECT 만 부여돼 있음을 실측 확인).
 *
 * 세 가지 함정이 있어 단순 조회로 끝나지 않는다:
 *
 * 1. **조인 키가 하나로 안 끝난다.** 국회가 식별자를 재발급한다. 스키마 주석은 "BILL_ID 가
 *    재발급되니 bill_no 로 조인하라"고 하는데, 반대 방향도 존재한다 — 의안번호 2218062
 *    (도시철도법, 2026-04-02)는 같은 bill_id 가 bills_status 에 2218065 로 들어 있다.
 *    그래서 bill_no 우선, 실패분만 bill_id 로 폴백한다. 이 순서로 20,035건 전건 매칭된다.
 *
 * 2. **bill_no 가 유일하지 않다.** 28건이 2행씩인데 오류가 아니라 재의요구(거부권) 재표결
 *    기록이다. PRC_* 가 원안, GOV_* 가 재의. 둘 다 의미가 있으므로 버리지 않고,
 *    PRC_ 를 대표행으로 삼고 GOV_ 는 재의 여부 플래그로 남긴다.
 *
 * 3. **synced_at 은 신선도가 아니다.** 변경분만 upsert 하는 설계라 "마지막으로 값이 바뀐
 *    시각"이다. 정상 동기화 중에도 몇 주 전으로 보이므로 기준일로 노출하면 안 된다.
 *    실행 단위 메타(bills_sync_runs)가 생기면 그때 신선도를 주장한다.
 *
 * PostgREST 임베딩(조인)은 두 테이블 사이에 FK 가 없어 PGRST200 으로 거부된다. 그래서
 * 법안을 먼저 뽑고 상태를 별도 조회해 앱에서 붙인다.
 */

import { getDb } from './supabase';

/** bills_status 에서 읽는 컬럼. 원문 URL 계열은 메인 테이블과 겹치므로 가져오지 않는다. */
const STATUS_COLUMNS =
  'bill_id, bill_no, pass_gubn, proc_stage_cd, current_committee, ' +
  'committee_referral_date, committee_present_date, committee_proc_date, committee_proc_result, ' +
  'law_referral_date, law_present_date, law_proc_date, law_proc_result, ' +
  'plenary_present_date, plenary_resolution_date, plenary_conf_name, plenary_result, ' +
  'govt_transfer_date, promulgation_law_name, promulgation_date, promulgation_no';

/** in.(...) 는 쿼리스트링에 실리므로 URL 길이 제한을 피해 배치로 나눈다 (bills.ts 와 동일 이유) */
const BATCH_SIZE = 150;

export interface BillStatusRow {
  bill_id: string;
  bill_no: string;
  pass_gubn: string | null;
  proc_stage_cd: string | null;
  current_committee: string | null;
  committee_referral_date: string | null;
  committee_present_date: string | null;
  committee_proc_date: string | null;
  committee_proc_result: string | null;
  law_referral_date: string | null;
  law_present_date: string | null;
  law_proc_date: string | null;
  law_proc_result: string | null;
  plenary_present_date: string | null;
  plenary_resolution_date: string | null;
  plenary_conf_name: string | null;
  plenary_result: string | null;
  govt_transfer_date: string | null;
  promulgation_law_name: string | null;
  promulgation_date: string | null;
  promulgation_no: string | null;
  /** 같은 의안번호에 GOV_* 재의 기록이 함께 있으면 true */
  has_reconsideration: boolean;
}

/** 상태를 붙일 수 있는 최소 형태 */
export interface BillKey {
  bill_no?: string | null;
  bill_id?: string | null;
}

/** DB 원본 행. has_reconsideration 은 DB 컬럼이 아니라 조회 후 계산해 붙이는 값이다. */
type StatusDbRow = Omit<BillStatusRow, 'has_reconsideration'>;

async function selectIn(column: 'bill_no' | 'bill_id', values: string[]): Promise<StatusDbRow[]> {
  if (values.length === 0) return [];

  const db = getDb();
  const batches: string[][] = [];
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    batches.push(values.slice(i, i + BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await db.from('bills_status').select(STATUS_COLUMNS).in(column, batch);
      if (error) throw new Error(`처리 상태 조회에 실패했습니다: ${error.message}`);
      return (data ?? []) as unknown as StatusDbRow[];
    })
  );

  return results.flat();
}

/**
 * 같은 의안번호의 여러 행에서 대표행 1개를 고른다.
 * PRC_(원안)를 대표로 삼고, GOV_(재의) 기록이 있으면 플래그만 세운다.
 */
function pickRepresentative(rows: StatusDbRow[]): BillStatusRow | undefined {
  if (rows.length === 0) return undefined;

  const original = rows.find((r) => r.bill_id?.startsWith('PRC_'));
  const base = original ?? rows[0];
  if (!base) return undefined;

  const hasReconsideration = rows.some((r) => r.bill_id?.startsWith('GOV_'));
  return { ...base, has_reconsideration: hasReconsideration };
}

/**
 * 법안 목록에 대응하는 처리 상태를 의안번호 기준 Map 으로 돌려준다.
 * bill_no 로 먼저 조회하고, 못 찾은 건만 bill_id 로 다시 조회한다.
 */
export async function fetchStatuses(bills: BillKey[]): Promise<Map<string, BillStatusRow>> {
  const byBillNo = new Map<string, BillStatusRow>();

  const billNos = [...new Set(bills.map((b) => b.bill_no).filter((v): v is string => !!v))];
  const primary = await selectIn('bill_no', billNos);

  const grouped = new Map<string, StatusDbRow[]>();
  for (const row of primary) {
    const list = grouped.get(row.bill_no) ?? [];
    list.push(row);
    grouped.set(row.bill_no, list);
  }
  for (const [billNo, rows] of grouped) {
    const rep = pickRepresentative(rows);
    if (rep) byBillNo.set(billNo, rep);
  }

  // 폴백: 의안번호가 재발급된 건들. 현재 전체 2만건 중 1건이지만 시간이 지나면 늘어난다.
  const missing = bills.filter((b) => b.bill_no && !byBillNo.has(b.bill_no) && b.bill_id);
  if (missing.length > 0) {
    const fallback = await selectIn(
      'bill_id',
      [...new Set(missing.map((b) => b.bill_id as string))]
    );
    const byBillId = new Map(fallback.map((r) => [r.bill_id, r]));

    for (const bill of missing) {
      const row = byBillId.get(bill.bill_id as string);
      // 키는 호출자가 아는 의안번호(메인 테이블 기준)로 맞춘다.
      // bills_status 쪽 bill_no 로 넣으면 호출자가 영영 찾지 못한다.
      if (row && bill.bill_no) {
        byBillNo.set(bill.bill_no, { ...row, has_reconsideration: false });
      }
    }
  }

  return byBillNo;
}

/**
 * 목록용: 각 법안에 상태 요약 문자열만 붙인다.
 *
 * 목록에는 요약 한 줄, 상세(bills_get)에는 전체 타임라인 — 기존 도구 분담과 같은 원칙이다.
 * 20건 목록 기준 상태 조회는 실측 82ms 라 목록 도구에 붙여도 부담이 없다.
 */
export async function attachStatusSummaries<T extends BillKey & { status_summary?: string }>(
  bills: T[]
): Promise<T[]> {
  if (bills.length === 0) return bills;

  const statuses = await fetchStatuses(bills);
  for (const bill of bills) {
    if (bill.bill_no) bill.status_summary = statusSummary(statuses.get(bill.bill_no));
  }
  return bills;
}

/** 목록 항목에 한 줄로 붙이는 상태 요약. 예: "계류 · 소관위심사" */
export function statusSummary(status: BillStatusRow | undefined): string {
  if (!status) return '상태 정보 없음';

  const track = status.pass_gubn === '처리의안' ? '처리' : status.pass_gubn === '계류의안' ? '계류' : null;
  const stage = status.proc_stage_cd ?? '단계 미상';
  const parts = [track, stage].filter(Boolean).join(' · ');

  // 재의요구 건은 대표행(PRC_)의 본회의 결과가 "원안가결"인데 이는 거부권 행사 이전의
  // 표결이다. 이걸 뒤에 붙이면 "재의(부결) (원안가결)" 처럼 최종 결과를 오인하게 만든다.
  // proc_stage_cd 가 이미 재의(가결)/재의(부결)로 결말을 말하므로 단계만 보여준다.
  if (status.has_reconsideration) return parts;

  // 공포까지 간 법은 시행 여부가 관심사라 날짜를 같이 준다.
  if (status.promulgation_date) return `${parts} (${status.promulgation_date} 공포)`;
  if (status.plenary_resolution_date && status.plenary_result) {
    return `${parts} (${status.plenary_resolution_date} ${status.plenary_result})`;
  }
  return parts;
}

/** bills_get 용 심사 경과 타임라인 */
export function renderStatusTimeline(status: BillStatusRow | undefined): string[] {
  const lines: string[] = ['## 처리 상태'];

  if (!status) {
    lines.push(
      '- 이 법안의 처리 상태를 찾지 못했습니다. 국회 원문 링크에서 직접 확인하세요.',
      ''
    );
    return lines;
  }

  lines.push(`- **현재**: ${statusSummary(status)}`);
  if (status.current_committee) lines.push(`- 소관위원회: ${status.current_committee}`);
  if (status.has_reconsideration) {
    lines.push('- ⚠️ 재의요구(거부권) 후 재표결 기록이 있는 법안입니다.');
  }
  lines.push('');

  const steps: string[] = [];
  const step = (label: string, date: string | null, result?: string | null) => {
    if (!date && !result) return;
    steps.push(`- ${label}: ${date ?? '날짜 미상'}${result ? ` — ${result}` : ''}`);
  };

  step('소관위 회부', status.committee_referral_date);
  step('소관위 상정', status.committee_present_date);
  step('소관위 처리', status.committee_proc_date, status.committee_proc_result);
  step('법사위 회부', status.law_referral_date);
  step('법사위 상정', status.law_present_date);
  step('법사위 처리', status.law_proc_date, status.law_proc_result);
  step('본회의 부의', status.plenary_present_date);
  step(
    '본회의 의결',
    status.plenary_resolution_date,
    [status.plenary_result, status.plenary_conf_name].filter(Boolean).join(' · ') || null
  );
  step('정부 이송', status.govt_transfer_date);
  step(
    '공포',
    status.promulgation_date,
    [status.promulgation_law_name, status.promulgation_no].filter(Boolean).join(' ') || null
  );

  if (steps.length > 0) {
    lines.push('### 심사 경과', ...steps, '');
  }

  if (status.proc_stage_cd === '대안반영폐기' || status.plenary_result === '대안반영폐기') {
    lines.push(
      '※ "대안반영폐기"는 부결이 아닙니다. 이 법안의 내용이 위원회 대안에 흡수되어 사실상 반영된 것입니다.',
      ''
    );
  }

  return lines;
}

/** JSON 응답용. 표시에 쓰지 않는 내부 키는 제외한다. */
export function statusToJson(status: BillStatusRow | undefined): Record<string, unknown> | null {
  if (!status) return null;
  const { bill_id: _billId, bill_no: _billNo, ...rest } = status;
  return rest;
}
