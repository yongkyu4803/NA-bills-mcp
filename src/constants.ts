/** 응답 1건의 최대 문자 수. 초과 시 결과를 잘라내고 안내 문구를 붙인다. */
export const CHARACTER_LIMIT = 25_000;

/** 질의 임베딩 모델 — DB의 embedding_v3 컬럼(1536차원)과 반드시 일치해야 한다. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

/** 외부 호출 타임아웃(ms) */
export const REQUEST_TIMEOUT_MS = 20_000;

/** 법안 도메인 분류 (실데이터 분포 기준) */
export const DOMAINS = [
  'economic',
  'social',
  'administrative',
  'political',
  'environmental',
  'cultural',
] as const;

/** 규제 성격 분류 */
export const REGULATION_TYPES = ['강화', '신설', '완화', '중립', '비규제'] as const;

/** 데이터 수록 범위 (도구 설명에 노출) */
export const DATA_COVERAGE = {
  from: '2024-05-30',
  to: '현재',
  assembly: '제22대 국회',
} as const;

/** 목록 조회 시 기본/최대 반환 건수 */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
