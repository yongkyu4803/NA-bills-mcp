# PRD — 법안 데이터 파이프라인 일일 자동화

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-08-12 |
| 상태 | 초안 (구현 대기) |
| 대상 저장소 | `yongkyu4803/exnews-next` (스크립트 위치), `~/.claude/skills/` (스킬 위치) |
| 관련 DB | Supabase `rxwztfdnragffxbmlscf` (20250320-exnews-supabase, ap-northeast-2) |

> 이 문서는 다른 세션·다른 프로젝트에서 단독으로 읽고 구현할 수 있도록 배경·수치·제약을 모두 담았다.

---

## 1. 배경 — 왜 필요한가

법안 데이터 파이프라인은 여러 단계로 나뉘어 있는데, **일부는 자주 실행되고 일부는 아무도 실행하지 않아** 같은 테이블 안에서 필드별로 최신성이 갈렸다.

2026-08-12 전수 조사 결과:

| 단계 | 실행 주체 | 상태 |
|---|---|---|
| 법안 수집 | `bills-monitor` / `daily-bills-search` 스킬 (수동) | ✅ 최신 (8/11) |
| LLM 4단계 요약 | 위 스킬에 포함 | ✅ 99.95% |
| 임베딩 (`embedding_v3`) | `bills-embeddings` 스킬 (수동) | ✅ 99.8% |
| LLM 주제 추출 (`bill_topics`) | `extract-topics-from-llm.ts` | ✅ 99.8% |
| **위원회 배정 (`committee`)** | `fill-missing-bill-committees.ts` | ❌ **2026-02부터 방치** |
| **의원 연결 (`bill_proposers`)** | `populate-bill-proposers.ts` | ❌ **2026-02부터 방치** |
| 토픽 클러스터링 | `cluster-by-factors.ts` 계열 | ⚠️ 2026-03 이후 신규분 미배정 |

방치 구간의 실측치(백필 이전):

```
월        법안수   위원회 결측   의원 연결
2026-01    641        6%          641/641
2026-02    677       72%            0/677
2026-04    735       91%            0/735
2026-06    564      100%            0/564
2026-08    180       99%            0/180
```

### 실제로 발생한 장애

- 공개 MCP 서버(`korea-bills-mcp.vercel.app`)에서 "이해식 의원 최근 법안"이 **0건** 반환
- `bills_statistics`의 상임위 집계가 **미분류 77.5%** 로 무의미
- 법안 상세 조회 시 2월 이후 법안은 발의자가 **빈 값**

원인은 코드가 아니라 데이터였다. **수동 실행에 의존하는 구조 자체가 원인**이므로, 스크립트를 한 번 더 돌리는 것으로는 재발을 막을 수 없다.

---

## 2. 목표

### 달성해야 할 것

1. 법안 수집 이후의 **모든 보강 단계가 매일 자동 실행**된다.
2. 어느 단계가 실패했는지 **사람이 알 수 있다** (조용한 실패 금지).
3. 각 단계는 **멱등**하다 — 중복 실행해도 데이터가 깨지지 않는다.
4. 하루 이상 밀린 갭은 다음 실행에서 **자동으로 따라잡는다**.

### 이번 범위가 아닌 것

- 공동발의자 수집 (원본 데이터에 이름이 없어 별도 과제 — 5절 참조)
- `bills_proposers` / `bill_proposers` 테이블 일원화 (별도 과제 — 5절)
- 클러스터링 알고리즘 개선

---

## 3. 설계

### 3.1 방식 선택: launchd + 셸 스크립트

같은 머신에서 이미 동작 중인 **`ordinance-monitor` 패턴을 그대로 따른다.**

- 참조 구현: `~/.claude/skills/ordinance-monitor/scripts/run_daily.sh`
- 참조 plist: `~/Library/LaunchAgents/com.ykpark.ordinance-monitor.plist` (매일 08:30)

**GitHub Actions를 쓰지 않는 이유**: 현재 보강 스크립트는 `.env.local`과 로컬 `npx tsx`에 의존하는 CLI다. Actions로 옮기려면 서버에서 실행 가능한 API 라우트로 감싸고 시크릿을 옮겨야 해서 작업량이 몇 배로 커진다. 기존 패턴과의 일관성도 잃는다.

**한계(수용함)**: 맥이 꺼져 있으면 실행되지 않는다. launchd는 `StartCalendarInterval`을 놓치면 다음 부팅 시 한 번 보충 실행하므로, 여기에 더해 **각 단계를 "갭 기반"으로 설계**해 며칠 밀려도 자동 복구되게 한다.

### 3.2 실행 순서

```
com.ykpark.bills-daily  (매일 07:30, ordinance-monitor 08:30과 겹치지 않게)
  └─ ~/.claude/skills/bills-pipeline/scripts/run_daily.sh
       1. 법안 수집        (신규 법안 적재)
       2. LLM 요약          (has_summary=false 대상)
       3. 임베딩            (embedding_v3 IS NULL 대상)
       4. 위원회 보강       ← 신규 편입
       5. 의원 연결         ← 신규 편입
       6. 주제 추출         (bill_topics 미할당 대상)
       7. 클러스터링        (주 1회, 월요일만)
       8. 헬스체크 + 알림
```

순서가 중요하다: 4·5단계는 1단계가 적재한 `proposer` 텍스트와 `bill_id`에 의존한다.

### 3.3 각 단계의 멱등성·갭 처리

| 단계 | 스크립트 | 대상 선정 방식 | 멱등성 |
|---|---|---|---|
| 위원회 보강 | `scripts/fill-missing-bill-committees.ts` | `committee IS NULL` 전체 | ✅ 결측만 갱신 |
| 의원 연결 | `scripts/populate-bill-proposers.ts` | 전체 스캔 | ✅ `upsert(ignoreDuplicates)` |
| 임베딩 | `bills-embeddings` 스킬 | `embedding_v3 IS NULL` | ✅ |
| 주제 추출 | `scripts/extract-topics-from-llm.ts` | 미할당분 증분 | ✅ |

**모든 단계가 "결측을 찾아 채우는" 방식이라 며칠 밀려도 다음 실행에서 자동으로 따라잡는다.** 날짜 기반 증분(`어제 것만`)으로 만들면 하루라도 건너뛸 때 영구 구멍이 생기므로 금지한다.

### 3.4 관측성 — 조용한 실패 방지

이번 사고의 본질은 "6개월간 아무도 몰랐다"는 것이다. 로그만으로는 부족하다.

**단계별 종료 코드를 수집해 요약을 남긴다.**

```bash
# 각 단계 후
record_step "committee" $? "$updated_count"
```

**실행 후 헬스체크 쿼리를 돌려 임계치를 넘으면 경고한다.**

| 지표 | 정상 | 경고 임계 |
|---|---|---|
| 최근 7일 법안 중 `committee` 결측률 | < 30% | ≥ 50% |
| 최근 7일 법안 중 의원 연결률 | > 80% | < 50% |
| 최근 3일 신규 법안 수 | > 0 | 0 (수집 중단 의심) |
| `embedding_v3` 결측 (전체) | < 100건 | ≥ 500건 |

> 위원회 결측률 임계가 느슨한 이유: 발의 직후에는 상임위가 배정되지 않은 법안이 정상적으로 존재한다. 백필 실측에서 국회 API가 위원회를 주지 않은 건이 3,840건 중 27건(0.7%)이었으나, 이는 과거 법안 기준이다.

**알림 경로**: 기존 `ordinance-monitor`가 로그 파일만 남기는 것과 달리, 경고 발생 시 사용자가 실제로 보는 채널로 보낸다. 우선순위:
1. Telegram (이 환경에 `telegram` 플러그인이 이미 연결돼 있음)
2. 실패 시 폴백 — `~/.claude/skills/bills-pipeline/logs/ALERT-YYYY-MM-DD.md` 생성

### 3.5 환경 제약 (반드시 지킬 것)

**① 쓰기에는 service_role 키가 필수**

2026-08-12 RLS 잠금 이후 `bills_*` / `bill_*` / `legislators` 계열 22개 테이블은 `anon`·`authenticated` 롤에 **SELECT 권한만** 있다. anon 키로 쓰면 `401 permission denied` 가 난다.

```ts
// 올바름
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// 틀림 — 401
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
```

이미 수정된 스크립트: `populate-bill-proposers.ts`, `fill-missing-bill-committees.ts`
**미확인 — 구현 시 점검 필요**: `extract-topics-from-llm.ts`, `cluster-by-topics.ts`, `bills-monitor` 계열 수집 스크립트

**② launchd의 최소 PATH**

launchd는 `/usr/bin:/bin:/usr/sbin:/sbin` 만 가지고 실행한다. `node`/`npx`/`python3`가 안 잡히므로 절대경로를 고정해야 한다. `ordinance-monitor/run_daily.sh` 가 python 인터프리터를 고정한 것과 같은 처리가 필요하다.

```bash
NODE_BIN="${BILLS_NODE:-$HOME/.nvm/versions/node/v24.14.1/bin/node}"
```

**③ 사전 의존성 점검**

`ordinance-monitor`는 수집기가 import 단계에서 죽으면 이전 JSON을 그대로 병합해 "정상 수집"으로 보고하는 사고가 있었다. 같은 함정을 피하려면 **각 단계 시작 전에 필요한 바이너리·환경변수 존재를 확인하고, 없으면 즉시 중단**한다.

**④ 필요한 환경변수** (`~/Documents/exnews-next-main/.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY      # 쓰기 전용, 절대 커밋 금지
ASSEMBLY_API_KEY               # 국회 Open API (위원회 조회)
OPENAI_API_KEY                 # 요약·임베딩·주제추출
```

---

## 4. 구현 작업 목록

### Phase 1 — 실행 스크립트 (필수)

- [ ] `~/.claude/skills/bills-pipeline/scripts/run_daily.sh` 작성
  - [ ] 절대경로 바이너리 고정, `set -uo pipefail`
  - [ ] 환경변수·바이너리 사전 점검 (없으면 exit 78)
  - [ ] 7단계 순차 실행, 각 단계 종료 코드·처리 건수 기록
  - [ ] 한 단계 실패해도 나머지 계속 (단, 1단계 수집 실패 시 전체 중단)
  - [ ] 날짜별 로그 `logs/YYYY-MM-DD.log`
- [ ] `scripts/healthcheck.ts` 작성 — 3.4절 지표 4종 계산, 임계 초과 시 exit 1
- [ ] 미확인 스크립트 3종의 service_role 키 사용 여부 점검·수정

### Phase 2 — 스케줄 등록

- [ ] `~/Library/LaunchAgents/com.ykpark.bills-daily.plist` 작성 (07:30)
- [ ] `launchctl load` 후 `launchctl start` 로 수동 1회 검증
- [ ] `RunAtLoad=false` (ordinance-monitor와 동일)

### Phase 3 — 알림

- [ ] 헬스체크 실패 시 Telegram 발송
- [ ] 발송 실패 시 `ALERT-*.md` 폴백

### Phase 4 — 검증

- [ ] 강제로 갭 생성(최근 7일 `committee`를 NULL로) 후 1회 실행 → 자동 복구 확인
- [ ] 연속 2회 실행 → 중복 데이터 미발생 확인 (멱등성)
- [ ] 환경변수 하나 제거 후 실행 → 조용히 성공하지 않고 경고가 뜨는지 확인

---

## 5. 이번 범위 밖 — 별도 과제

### 5.1 공동발의자 데이터 부재

`bills_monitor_bills.proposer` 는 `"이해식의원 등 10인"` 형식이라 **나머지 9명의 이름이 원본에 없다.** 그 결과:

- `bills_proposers` 16,222행 중 공동발의(`is_primary=false`)는 **156행뿐**
- "A 의원이 공동발의에 참여했는가"는 현재 데이터로 답할 수 없음

해결하려면 국회 Open API에서 발의자 명단을 별도로 수집하는 단계를 신설해야 한다. **파싱 개선으로는 불가능하다.**

### 5.2 발의자 테이블 이중화

같은 목적의 테이블이 둘 존재하며 서로 다르게 낡는다.

| 테이블 | 채우는 주체 | 스키마 | 2026-08 기준 |
|---|---|---|---|
| `bill_proposers` | `populate-bill-proposers.ts` | `bill_id`, `legislator_id`, `is_primary_proposer` | 19,368행 (백필 완료) |
| `bills_proposers` | DB 함수 `parse_and_insert_proposers()` | `bill_uuid`, `member_name`, `is_primary` | 16,222행 (2026-01에서 정지) |

- MCP 서버는 이제 **둘 다 쓰지 않는다** (메인 테이블 `proposer` 텍스트 직접 파싱으로 전환)
- **exnews 웹앱은 여전히 낡은 `bills_proposers` 를 쓴다** → `src/lib/billProposers.ts`, `src/pages/api/bills-proposers.ts`. 웹사이트에도 같은 증상이 있을 것으로 추정되나 미확인
- ⚠️ `parse_and_insert_proposers()` 는 **중복 방지 장치가 없다.** 재실행하면 16,222행이 통째로 복제되므로 절대 호출하지 말 것

권장: `bills_proposers` 폐기하고 `bill_proposers` 로 일원화. 웹앱 조회 경로 2곳 이전 필요.

### 5.3 상시 실패 중인 GitHub Action

`.github/workflows/cron-news-check.yml` 이 5분마다 호출하는
`https://exnews-next.vercel.app/api/cron/check-new-news` 가 **404** 다 (라우트가 레포에 없음).

워크플로가 `set +e` 로 오류를 삼켜 Actions는 성공으로 표시된다. 하루 288회 실패 중이며 푸시 알림 기능이 죽어 있을 가능성이 높다. 기능을 계속 쓸 것인지 판단 후 라우트 복구 또는 워크플로 삭제가 필요하다.

---

## 6. 성공 기준

구현 완료 후 다음이 모두 참이어야 한다.

1. 하루 방치해도 다음 실행에서 결측이 0에 수렴한다.
2. 임의의 단계를 고장 냈을 때, 그 사실이 24시간 안에 사용자에게 도달한다.
3. 스크립트를 연속 3회 실행해도 행 수가 증가하지 않는다.
4. 최근 7일 법안의 위원회 결측률과 의원 연결률이 임계 안에 머문다.
5. 공개 MCP 서버에서 "특정 의원의 최근 법안" 질의가 당일 발의분까지 반환한다.
