/**
 * 처리 상태 데이터의 신선도.
 *
 * 왜 별도 테이블을 읽는가: bills_status.synced_at 은 변경분만 upsert 하는 설계라
 * "마지막으로 값이 바뀐 시각"이다. 국회가 조용한 주에는 정상 동기화 중에도 몇 주 전으로
 * 보이므로, 그걸 기준일로 쓰면 멀쩡한 데이터를 낡았다고 표시하게 된다.
 * 실행 단위 메타(bills_sync_runs)의 마지막 **성공** 시각만이 "언제 확인했나"에 답한다.
 *
 * 이 신호가 필요한 이유는 실제 장애로 증명됐다. 2026-08-15 동기화 크론이 60초 타임아웃으로
 * 매일 실패하고 있었는데, 데이터만 봐서는 "변동 없는 정상"과 구별되지 않았다.
 *
 * 임계값 48시간: 크론이 일 1회라 1회 실패는 흡수한다. 상류(국회 API)가 출렁이는 날
 * 실행 시간이 5초에서 74초까지 튀는 것이 관측돼 1회 실패는 정상 범위로 본다.
 * 더 조이면 오탐이 나고, 오탐이 나는 경고는 곧 무시된다.
 */

import { getDb } from './supabase';

const STALE_AFTER_HOURS = 48;
const SYNC_JOB = 'bills_status';

/** 웜 인스턴스 재사용. 도구 호출마다 조회하면 왕복이 하나씩 늘어나는데 값은 하루 1회만 바뀐다. */
const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; value: Freshness } | null = null;

export interface Freshness {
  /** 마지막 동기화 성공 시각(ISO). 확인 불가면 null */
  finishedAt: string | null;
  hoursAgo: number | null;
  stale: boolean;
  /** 조회 자체가 실패했거나 실행 기록이 없으면 false — 이때는 아무 주장도 하지 않는다 */
  known: boolean;
}

const UNKNOWN: Freshness = { finishedAt: null, hoursAgo: null, stale: false, known: false };

export async function getStatusFreshness(): Promise<Freshness> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  let value = UNKNOWN;
  try {
    const { data, error } = await getDb()
      .from('bills_sync_runs')
      .select('finished_at')
      .eq('job', SYNC_JOB)
      .eq('status', 'success')
      .order('finished_at', { ascending: false })
      .limit(1);

    const finishedAt = error ? null : ((data?.[0]?.finished_at as string | undefined) ?? null);

    if (finishedAt) {
      const hoursAgo = (Date.now() - new Date(finishedAt).getTime()) / 3_600_000;
      value = {
        finishedAt,
        hoursAgo,
        stale: hoursAgo > STALE_AFTER_HOURS,
        known: true,
      };
    }
  } catch {
    // 신선도는 부가 정보다. 여기서 예외를 올리면 조회 자체가 실패하므로 삼킨다.
    // 대신 known=false 로 두어 근거 없는 기준일을 주장하지 않는다.
    value = UNKNOWN;
  }

  cache = { at: Date.now(), value };
  return value;
}

/** 국회 데이터라 KST 로 표기한다. 서버는 UTC 로 돌지만 읽는 사람은 한국 기준으로 본다. */
function formatKst(iso: string): string {
  // 로케일 출력 문자열을 정규식으로 다듬으면 런타임(Node 버전·ICU)에 따라 깨진다.
  // 부품을 직접 조립해 형식을 고정한다.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour'); // hour12:false 는 자정을 24로 준다
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')} KST`;
}

/** 마크다운 응답에 붙일 한 줄. 확인 불가면 null — 침묵이 근거 없는 기준일보다 낫다. */
export function freshnessNote(f: Freshness): string | null {
  if (!f.known || !f.finishedAt) return null;

  if (f.stale) {
    // 임계값이 48시간이라 실사용에서는 항상 2일 이상이지만, 임계값을 낮추면 "0일째"가
    // 나오므로 하루 미만은 시간으로 말한다.
    const hours = Math.floor(f.hoursAgo ?? 0);
    const elapsed = hours >= 24 ? `${Math.floor(hours / 24)}일째` : `${hours}시간째`;
    return (
      `⚠️ 처리 상태가 ${elapsed} 갱신되지 않았습니다 (마지막 동기화 성공 ${formatKst(f.finishedAt)}). ` +
      `표시된 심사 단계가 실제와 다를 수 있으니 각 법안의 원문 링크에서 확인하세요.`
    );
  }
  return `※ 처리 상태 기준: ${formatKst(f.finishedAt)} (마지막 동기화 성공)`;
}

/** JSON 응답의 data_scope 에 합칠 조각 */
export function freshnessJson(f: Freshness): Record<string, unknown> {
  if (!f.known || !f.finishedAt) {
    return { status_as_of: null, status_stale: null };
  }
  return { status_as_of: f.finishedAt, status_stale: f.stale };
}
