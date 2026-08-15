# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

제22대 국회(2024-05-30~) 발의 법안 약 2만건을 노출하는 **읽기 전용 Remote MCP 서버**. Next.js App Router 라우트 하나(`app/api/mcp/route.ts`)가 서버 전체이고, `app/page.tsx` 는 연결 방법을 안내하는 랜딩 페이지다. 데이터는 외부 Supabase 프로젝트에 이미 적재되어 있고 이 저장소는 조회만 한다(수집·요약·임베딩 파이프라인은 별도 스킬/스크립트가 담당 — `docs/PRD-bills-daily-automation.md` 참고).

## 명령어

```bash
npm run dev        # http://localhost:3000/api/mcp
npm run typecheck  # tsc --noEmit — 테스트가 없으므로 사실상 유일한 자동 검증 수단
npm run build      # 프로덕션 빌드
vercel --prod      # 배포 (프로젝트는 이미 link 되어 있음)
```

테스트 러너는 없다. 대신 `evaluation.xml` 에 DB 로 검증된 QA 쌍이 있어, 도구 동작을 바꿨을 때 MCP 클라이언트로 직접 질문해 회귀를 확인한다.

로컬 실행에는 `.env.local` 이 필요하다(`.env.local.example` 참고). `OPENAI_API_KEY` 가 없으면 `bills_search` 만 비활성화되고 나머지 도구는 정상 동작하므로, 검색 외 작업은 키 없이도 개발할 수 있다.

## 아키텍처

```
app/api/mcp/route.ts   요청 제한 → createMcpHandler → 7개 register*() 호출
src/tools/*.ts         도구 1개 = 파일 1개. registerXxx(server) 를 export
src/services/*.ts      도구들이 공유하는 횡단 관심사
src/constants.ts       한도·모델명·분류값 등 매직넘버의 단일 출처
```

도구를 추가할 때는 `src/tools/` 에 파일을 만들고 `registerXxx(server)` 를 export 한 뒤 `route.ts` 에서 호출한다. 각 도구는 동일한 골격을 따른다:

1. `z.object({...}).strict()` 로 입력 스키마 정의 — `commonFilters` / `limitField` / `offsetField` / `ResponseFormat` 를 재사용
2. `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`
3. 핸들러 본문을 `runTool(async () => ...)` 로 감싼다 — 예외를 LLM 이 대응 가능한 한국어 문구로 변환하고 내부 구현을 숨긴다
4. 마크다운 출력은 `renderWithLimit()` 로 감싼다 — 25,000자를 넘으면 항목을 절반씩 줄이고 안내 문구를 붙인다

### 도구 설명(description)이 곧 인터페이스다

description 은 문서가 아니라 LLM 이 읽는 스펙이다. 기존 도구들은 **언제 이 도구가 아니라 다른 도구를 써야 하는지**, JSON 반환 스키마, 실데이터 분포(예: `domain` 별 건수, 미분류 건수)를 모두 담고 있다. 새 도구를 만들거나 필터를 바꿀 때 이 수준을 유지할 것. 분류값 건수는 `src/services/bills.ts` 의 `commonFilters` describe 에 하드코딩되어 있으므로 데이터가 크게 바뀌면 함께 갱신한다.

모든 도구는 `readOnlyHint: true, destructiveHint: false` 로 선언되어야 한다.

### 데이터 접근 규칙

- Supabase 클라이언트는 `getDb()` 로만 얻는다(모듈 레벨 캐시, anon 키). 컬럼 목록은 `BILL_LIST_COLUMNS` / `BILL_DETAIL_COLUMNS` 를 쓴다 — 임베딩 벡터를 실수로 실어 보내지 않기 위함이다.
- id 목록으로 조회할 때는 반드시 `fetchBillsByIds()` 를 쓴다. PostgREST 의 `in.(...)` 는 쿼리스트링에 실리므로 id 가 수백 개면 URL 길이 제한으로 요청 자체가 실패한다(150개 배치로 병렬 조회).
- 응답에서 내부 UUID 는 `stripInternalIds()` 로 제거한다. 외부에 노출하는 법안 식별자는 **의안번호(`bill_no`) 하나로 통일**한다.

주요 테이블: `bills_monitor_bills`(법안 본문+4단계 요약+`embedding_v3`), `legislators`(의원 명단), `bill_topic_clusters`(주제 클러스터), `bills_monitor_reports`(일일 리포트). 시맨틱 검색은 RPC `match_bills_v3` 를 호출한다.

### 발의자 조회 — 중간 테이블을 쓰지 말 것

`bill_proposers` / `bills_proposers` 중간 테이블은 수동 스크립트로 채워져 최신 법안에 수개월씩 뒤처진다(실제로 "이해식 의원 최근 법안 0건" 장애의 원인). 발의자 판정은 **`bills_monitor_bills.proposer` 텍스트 파싱**이 유일한 진실 공급원이며, 파싱 로직은 전부 `src/services/proposer.ts` 에 있다. 의원 이름 매칭은 `proposerLikePattern()`("%이름의원%" 앵커)로 부분 일치 오탐을 막는다.

이 텍스트에는 대표발의자만 들어 있다 — "등 10인"의 나머지는 원문에 이름이 없어 어떤 방법으로도 얻을 수 없고, 정부 제출·위원장 발의는 개인 의원이 없다. 도구 설명에 이 한계를 명시해야 한다.

의원 단위 조회는 DB 페이지네이션으로 처리하지만, 정당 단위는 소속 의원 명단을 받아 앱에서 필터링하므로 스캔 범위가 `MAX_PARTY_SCAN`(2,000건)을 넘으면 기간을 좁히도록 안내하고 중단한다 — 임의 부분집합을 반환하지 않는다.

### 임베딩

`EMBEDDING_MODEL`(text-embedding-3-small) / `EMBEDDING_DIMENSIONS`(1536) 는 DB `embedding_v3` 컬럼 생성에 쓰인 값과 **반드시 일치해야 한다**. 바꾸면 유사도가 무의미해진다. 질의 임베딩은 웜 인스턴스 메모리에 200개까지 캐시된다.

### 요청 제한

`src/services/rateLimit.ts` 는 서버리스 인스턴스 메모리 기반 고정 창(IP+분)이다. 인스턴스가 여러 개면 실제 허용량이 설정값을 넘으므로 스크래핑 차단 장치가 아니다. 엄격한 제한이 필요해지면 Upstash Redis 등 공유 저장소로 교체한다.

## 규약

- 사용자에게 보이는 문자열(도구 설명, 오류 메시지, 마크다운 출력)은 **한국어**로 쓴다. 오류 메시지는 원인만 알리지 말고 "대신 무엇을 하라"까지 담는다(예: 임베딩 실패 시 `bills_filter` 안내).
- 코드 주석은 "무엇"이 아니라 **왜 이렇게 되어 있는지**(제약·실측 분포·과거 장애)를 적는다. 기존 파일들의 헤더 주석이 그 예다.
- 경로 별칭 `@/*` → `src/*`. `strict` + `noUncheckedIndexedAccess` 가 켜져 있으므로 배열 인덱싱 결과는 항상 undefined 를 고려한다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
