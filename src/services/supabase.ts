import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * 법안 DB 클라이언트 (읽기 전용).
 *
 * 사용하는 키는 anon 키이며, 대상 테이블들은 RLS 로 SELECT 만 허용되어 있다.
 * 즉 이 서버는 구조적으로 데이터를 변경할 수 없다.
 */

let cached: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      '서버 설정 오류: SUPABASE_URL 과 SUPABASE_ANON_KEY 환경변수가 필요합니다.'
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}

/**
 * 법안 목록 조회 시 공통으로 가져오는 컬럼 (임베딩 벡터는 제외해 응답 용량을 줄인다).
 *
 * bill_id 는 응답에 싣지 않지만, 처리 상태 조인에서 의안번호가 재발급된 건을 구제하는
 * 폴백 키로 필요하다(services/status.ts 참조). stripInternalIds() 가 렌더 직전에 제거한다.
 */
export const BILL_LIST_COLUMNS =
  'id, bill_id, bill_no, bill_name, proposer, proposal_date, committee, domain, ' +
  'regulation_type, summary_one_sentence, link_url';

/**
 * id 목록으로 법안을 조회한다.
 *
 * PostgREST 는 `in.(...)` 필터를 URL 쿼리스트링에 담기 때문에, id 가 수백 개가 되면
 * URL 길이 제한에 걸려 요청 자체가 실패한다(정당 단위 조회 등). 배치로 나눠 병렬 조회한다.
 */
const ID_BATCH_SIZE = 150;

export async function fetchBillsByIds<T = Record<string, unknown>>(
  ids: string[],
  columns: string,
  refine?: (q: ReturnType<SupabaseClient['from']>['select'] extends never ? never : any) => unknown
): Promise<T[]> {
  if (ids.length === 0) return [];

  const db = getDb();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    batches.push(ids.slice(i, i + ID_BATCH_SIZE));
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      let q = db.from('bills_monitor_bills').select(columns).in('id', batch);
      if (refine) q = refine(q) as typeof q;

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as T[];
    })
  );

  return results.flat();
}

/** 법안 상세 조회 컬럼 */
export const BILL_DETAIL_COLUMNS =
  'id, bill_id, bill_no, bill_name, proposer, proposal_date, committee, domain, ' +
  'regulation_type, regulation_affected_groups, summary_one_sentence, ' +
  'summary_easy_explanation, summary_why_important, summary_who_affected, ' +
  'link_url, topic_cluster_id, created_at';
