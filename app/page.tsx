const TOOLS: Array<[string, string]> = [
  ['bills_search', '자연어 의미 기반 법안 검색'],
  ['bills_filter', '분야·위원회·기간·규제성격 조건 검색'],
  ['bills_get', '의안번호로 법안 상세 + 공동발의자 조회'],
  ['bills_by_legislator', '의원·정당별 발의 법안'],
  ['bills_statistics', '분야·위원회·월별 발의 통계'],
  ['bills_topics', '주제별 법안군(클러스터) 조회'],
  ['bills_daily_report', '일일 법안 동향 리포트'],
];

export default function Home() {
  return (
    <main>
      <h1>국회 법안 MCP 서버</h1>
      <p>
        제22대 국회 발의 법안 약 2만건(2024-05-30~)을 MCP 도구로 제공합니다.
        모든 도구는 <strong>읽기 전용</strong>입니다.
      </p>

      <h2>연결 방법</h2>
      <p>MCP 클라이언트 설정에 아래를 추가하세요.</p>
      <pre style={{ background: '#f4f4f5', padding: '1rem', borderRadius: 8, overflowX: 'auto' }}>
{`{
  "mcpServers": {
    "korea-bills": {
      "url": "https://korea-bills-mcp.vercel.app/api/mcp"
    }
  }
}`}
      </pre>

      <h2>제공 도구</h2>
      <ul>
        {TOOLS.map(([name, desc]) => (
          <li key={name}>
            <code>{name}</code> — {desc}
          </li>
        ))}
      </ul>

      <h2>데이터 출처</h2>
      <p>
        국회 의안정보시스템 공개 데이터를 수집·요약한 것입니다. 요약문은 자동 생성되었으므로
        법적 판단의 근거로 삼기 전에 각 법안의 원문 링크를 확인하세요.
      </p>
    </main>
  );
}
