import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, REQUEST_TIMEOUT_MS } from '@/constants';

/**
 * 질의 텍스트를 임베딩 벡터로 변환한다.
 *
 * DB의 embedding_v3 컬럼이 text-embedding-3-small(1536차원)로 생성되어 있으므로
 * 질의도 동일 모델을 써야 유사도가 의미를 갖는다.
 */

/** 임베딩 기능 사용 가능 여부 (OPENAI_API_KEY 설정 여부) */
export function isSemanticSearchAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** 동일 질의 반복 호출 시 재사용하는 캐시 (웜 인스턴스 한정) */
const cache = new Map<string, number[]>();
const CACHE_MAX = 200;

export async function embedQuery(query: string): Promise<number[]> {
  const key = query.trim().toLowerCase();

  const hit = cache.get(key);
  if (hit) return hit;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '이 서버에는 시맨틱 검색이 설정되어 있지 않습니다. 대신 bills_filter 로 키워드·조건 검색을 사용하세요.'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: query,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('임베딩 API 사용량 한도에 도달했습니다. 잠시 후 다시 시도하거나 bills_filter 를 사용하세요.');
      }
      throw new Error(`임베딩 생성에 실패했습니다 (HTTP ${res.status}). bills_filter 로 키워드 검색을 시도해 보세요.`);
    }

    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;

    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error('임베딩 응답 형식이 올바르지 않습니다.');
    }

    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, embedding);

    return embedding;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('임베딩 생성이 시간 초과되었습니다. 다시 시도하거나 bills_filter 를 사용하세요.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
