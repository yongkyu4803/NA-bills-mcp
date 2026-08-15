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

/**
 * 이 서버의 스코프 경계.
 *
 * 2026-08-15 이전에는 발의 시점 정보만 있었고 "처리 결과는 영구히 제공하지 않는다"고 선언했다.
 * 같은 날 daily-bills 파이프라인이 bills_status(ALLBILLV2 미러)를 같은 DB에 적재하면서
 * 그 선언이 거짓이 됐다. 데이터가 생기면 경계 문구를 **같은 배포에서** 함께 뒤집어야 한다.
 * 없는 것을 있다고 하는 것만큼이나, 있는 것을 없다고 하는 것도 조용한 오답이다.
 *
 * 신선도는 여기서 주장하지 않는다. bills_status.synced_at 은 "마지막 확인 시각"이 아니라
 * "마지막으로 값이 바뀐 시각"이라(변경분만 upsert) 정상 동기화 중에도 몇 주 전으로 보인다.
 * 실행 단위 메타(bills_sync_runs)가 생기기 전까지 기준일 주장은 하지 않는다 — 근거 없는
 * 기준일보다 침묵이 낫다.
 */
export const SCOPE_NOTICE = `📌 제공 범위
  - 발의 정보: 법안명·발의일·대표발의자·소관위원회·자동 생성 요약·분야/규제 분류
  - 처리 상태: 현재 심사단계, 소관위·법사위 심사일정과 결과, 본회의 의결 결과, 공포일까지
    (출처: 국회 열린국회정보 ALLBILLV2, 일 1회 동기화)

제공하지 않는 것:
  - **공동발의자 명단** — 원문 표기가 "홍길동의원 등 10인"이라 나머지 이름이 존재하지 않는다
  - 회의록·심사 발언·축조심사 세부 내용
  - 결의안·동의안·예산안 (수록 대상은 법률안뿐)

⚠️ 해석 주의 — "대안반영폐기"(약 3,834건)는 실패가 아니다. 법안 내용이 위원회 대안에 흡수돼
사실상 반영된 것인데 명칭만 폐기다. 이것을 부결·폐기와 같이 묶어 가결률을 계산하면 수치가
통째로 왜곡된다. 발의 건수나 가결 여부를 의원 개인의 성과로 단정하지 말 것.`;

/** 응답 하단에 붙는 짧은 경계 안내 (SCOPE_NOTICE 의 요약판) */
export const SCOPE_FOOTER = `---
※ 처리 상태는 국회 ALLBILLV2 를 일 1회 동기화한 값입니다. "대안반영폐기"는 부결이 아니라 위원회 대안에 내용이 반영된 것이므로 실패로 해석하지 마세요. 최종 확인은 각 법안의 원문 링크(국회 의안정보시스템)를 권합니다.`;

/** JSON 응답에 실리는 기계 판독용 경계 표기 */
export const SCOPE_JSON = {
  includes: [
    '발의 정보',
    '자동 생성 요약',
    '분야·규제 분류',
    '소관위원회',
    '처리 상태(심사단계·본회의 결과·공포)',
  ],
  excludes: ['공동발의자 명단', '회의록·심사 발언', '결의안·동의안·예산안'],
  status_source: 'ALLBILLV2 (국회 열린국회정보), 일 1회 동기화',
  caveat:
    '"대안반영폐기"는 부결이 아니라 위원회 대안에 내용이 반영된 것이다. 실패로 집계하면 가결률이 왜곡된다.',
} as const;

/**
 * 상태 집계·필터를 아직 지원하지 않는 도구(bills_statistics·bills_topics·bills_daily_report)에
 * 붙이는 안내. 개별 법안 상태는 볼 수 있는데 이 도구로는 못 거른다는 사실을 밝히지 않으면
 * 에이전트가 "상태별 집계가 불가능하다"로 잘못 일반화한다.
 */
export const STATUS_UNSUPPORTED_NOTE = `이 도구는 처리 상태로 거르거나 집계하지 못한다(집계 축은 발의 기준뿐).
개별 법안의 처리 상태는 bills_get·bills_filter·bills_search 결과에 표시된다.`;

/** 목록 조회 시 기본/최대 반환 건수 */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
