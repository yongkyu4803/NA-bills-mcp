/**
 * 발의자 텍스트 파싱.
 *
 * `bills_monitor_bills.proposer` 는 대표발의자만 담고 있다.
 * "등 10인"의 나머지 9명은 원문에 이름이 없으므로 어떤 방법으로도 얻을 수 없다.
 *
 * 이 파일이 유일한 진실 공급원인 이유:
 * 중간 테이블(bills_proposers / bill_proposers)은 수동 스크립트로 채워져
 * 최신 법안에 수개월씩 뒤처지지만, 이 텍스트는 법안과 함께 항상 최신이다.
 *
 * 실측 분포 (전체 19,999건):
 *   92.3% "홍길동의원 등 10인"      → [홍길동]
 *    4.2% "교육위원장"              → []       (위원회 대안)
 *    2.4% "정부"                    → []       (정부 제출)
 *    1.0% "권영진의원ㆍ복기왕의원 등 10인" → [권영진, 복기왕] (공동 대표발의)
 *    0.2% "문금주의원 외 10인"      → [문금주] ('등' 대신 '외')
 */

/** 공동 대표발의 구분자 (가운뎃점 변종) */
const SEPARATORS = /[ㆍ・·]/;

/**
 * 발의자 텍스트에서 대표발의 의원 이름을 추출한다.
 * 정부 제출·위원장 발의처럼 개인 의원이 없는 경우 빈 배열을 반환한다.
 */
export function extractProposerNames(proposer: unknown): string[] {
  if (typeof proposer !== 'string') return [];

  const text = proposer.trim();
  if (!text) return [];

  // 정부 제출 / 위원회 대안 — 개인 의원 없음
  if (text === '정부') return [];
  if (/위원장$/.test(text)) return [];

  // "등 10인" / "외 10인" 꼬리 제거
  const head = text.replace(/\s*(등|외)\s*\d+\s*인.*$/, '').trim();

  return head
    .split(SEPARATORS)
    .map((part) => part.replace(/의원\s*$/, '').trim())
    .filter((name) => name.length >= 2 && name.length <= 10);
}

/** 대표발의자 1명만 필요할 때 (공동 대표발의면 첫 번째) */
export function primaryProposerName(proposer: unknown): string | null {
  return extractProposerNames(proposer)[0] ?? null;
}

/**
 * 의원 이름으로 proposer 텍스트를 매칭하는 ILIKE 패턴.
 * "의원"을 앵커로 붙여 부분 일치 오탐을 막는다 (예: "김민"이 "김민석의원"에 걸리지 않음).
 */
export function proposerLikePattern(memberName: string): string {
  return `%${memberName}의원%`;
}
