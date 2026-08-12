# korea-bills-mcp-server

제22대 국회(2024-05-30~) 발의 법안 약 2만건을 MCP 도구로 제공하는 **읽기 전용** Remote MCP 서버입니다.

각 법안에는 자동 생성된 4단계 요약(한 줄 요약 / 쉬운 설명 / 왜 중요한가 / 영향 대상)이 붙어 있어,
법안 원문을 읽지 않고도 내용을 파악할 수 있습니다.

## 제공 도구

| 도구 | 용도 |
|---|---|
| `bills_search` | 자연어 의미 기반 검색 (임베딩 유사도) |
| `bills_filter` | 분야·위원회·기간·규제성격·키워드 조건 검색 |
| `bills_get` | 의안번호로 상세 조회 (4단계 요약 + 공동발의자 명단) |
| `bills_by_legislator` | 의원·정당별 발의 법안 (대표/공동 구분) |
| `bills_statistics` | 분야·위원회·월별 발의 분포와 추이 |
| `bills_topics` | 주제별 법안군(클러스터) 278개 조회 |
| `bills_daily_report` | 일일 법안 동향 리포트 약 500건 |

모든 도구는 `response_format` 으로 `markdown`(기본) / `json` 출력을 선택할 수 있고,
목록 도구는 `limit` / `offset` 페이지네이션을 지원합니다.

## 연결 방법

MCP 클라이언트 설정에 추가합니다.

```json
{
  "mcpServers": {
    "korea-bills": {
      "url": "https://korea-bills-mcp.vercel.app/api/mcp"
    }
  }
}
```

Claude Code에서는 다음과 같이 등록할 수도 있습니다.

```bash
claude mcp add --transport http korea-bills https://korea-bills-mcp.vercel.app/api/mcp
```

## 배포 (Vercel)

```bash
vercel link          # 새 프로젝트 생성
vercel env add SUPABASE_URL production
vercel env add SUPABASE_ANON_KEY production
vercel env add OPENAI_API_KEY production
vercel env add RATE_LIMIT_PER_MINUTE production   # 선택, 기본 60
vercel --prod
```

| 환경변수 | 필수 | 설명 |
|---|---|---|
| `SUPABASE_URL` | ✅ | 법안 DB 프로젝트 URL |
| `SUPABASE_ANON_KEY` | ✅ | **읽기 전용** anon 키. 대상 테이블은 RLS 로 SELECT 만 허용 |
| `OPENAI_API_KEY` | — | 질의 임베딩용. 없으면 `bills_search` 만 비활성화되고 나머지는 정상 동작 |
| `RATE_LIMIT_PER_MINUTE` | — | IP당 분당 요청 상한 (기본 60) |

## 로컬 실행

```bash
npm install
cp .env.local.example .env.local   # 값 채우기
npm run dev                        # http://localhost:3000/api/mcp
```

## 보안

- 서버가 사용하는 anon 키는 대상 테이블에 **SELECT 권한만** 있습니다. 구조적으로 데이터를 변경할 수 없습니다.
- 키는 서버에만 존재하며 클라이언트에 노출되지 않습니다.
- 모든 도구는 `readOnlyHint: true`, `destructiveHint: false` 로 선언되어 있습니다.

## 알려진 제약

- **발의자 정보 지연**: `bills_by_legislator` 가 쓰는 의원 연결 데이터는 법안 데이터보다 갱신이 늦습니다.
  최근 발의된 법안은 의원 정보가 없어 조회되지 않으며, 이 경우 `bills_filter` 를 사용해야 합니다.
- **미분류 값**: 규제 성격은 약 3,572건, 소관위원회는 약 3,840건이 미분류/미지정 상태입니다.
  해당 필터를 지정하면 이 건들은 결과에서 빠집니다.
- **거대 정당 전체 조회**: 발의 건수가 2,000건을 넘으면 임의 부분집합을 반환하는 대신
  기간을 좁히도록 안내합니다.
- **요청 제한**: 서버리스 인스턴스 메모리 기반이라 인스턴스가 여러 개면 실제 허용량이 설정값보다
  커질 수 있습니다. 엄격한 제한이 필요하면 Upstash Redis 등 공유 저장소로 교체하세요.
- **응답 상한**: 응답 1건은 25,000자로 제한되며, 초과 시 항목을 줄이고 안내 문구를 덧붙입니다.

## 데이터 출처와 주의

국회 의안정보시스템 공개 데이터를 수집·요약한 것입니다.
**요약문은 자동 생성되었으므로 법적·업무적 판단의 근거로 삼기 전에 각 법안의 원문 링크를 확인하세요.**

## 개발

```bash
npm run typecheck    # tsc --noEmit
npm run build        # 프로덕션 빌드
```
