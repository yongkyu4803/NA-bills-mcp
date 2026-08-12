import { createMcpHandler } from 'mcp-handler';
import { registerSearch } from '@/tools/search';
import { registerFilter } from '@/tools/filter';
import { registerDetail } from '@/tools/detail';
import { registerLegislator } from '@/tools/legislator';
import { registerStatistics } from '@/tools/statistics';
import { registerTopics } from '@/tools/topics';
import { registerReports } from '@/tools/reports';
import { checkRateLimit, clientKey } from '@/services/rateLimit';

export const maxDuration = 60;

const mcpHandler = createMcpHandler(
  (server) => {
    registerSearch(server);
    registerFilter(server);
    registerDetail(server);
    registerLegislator(server);
    registerStatistics(server);
    registerTopics(server);
    registerReports(server);
  },
  {
    serverInfo: { name: 'korea-bills-mcp-server', version: '1.0.0' },
    instructions:
      '대한민국 제22대 국회(2024-05-30~) 발의 법안 약 2만건을 조회하는 읽기 전용 서버입니다. ' +
      '주제·내용으로 찾을 때는 bills_search, 위원회·기간·분야 조건으로 훑을 때는 bills_filter, ' +
      '특정 법안의 상세와 공동발의자는 bills_get 을 사용하세요. ' +
      '법안 요약문은 자동 생성된 것이므로 중요한 판단에는 각 법안의 원문 링크를 확인하도록 안내해야 합니다.',
  }
);

async function handler(req: Request): Promise<Response> {
  const { allowed, remaining, retryAfterSec } = checkRateLimit(clientKey(req));

  if (!allowed) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32029,
          message: `요청이 너무 잦습니다. ${retryAfterSec}초 후 다시 시도하세요.`,
        },
        id: null,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSec),
        },
      }
    );
  }

  const res = await mcpHandler(req);
  res.headers.set('X-RateLimit-Remaining', String(remaining));
  return res;
}

export { handler as GET, handler as POST, handler as DELETE };
