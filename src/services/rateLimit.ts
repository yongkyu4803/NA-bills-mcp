/**
 * 간이 요청 제한 (IP + 분 단위 고정 창).
 *
 * 한계: 서버리스 인스턴스 메모리에만 존재하므로 인스턴스가 여러 개면
 * 실제 허용량은 (설정값 × 인스턴스 수)까지 올라간다. 스크래핑을 완전히
 * 막는 장치가 아니라 단일 클라이언트의 폭주를 눌러주는 수준이다.
 * 엄격한 제한이 필요해지면 Upstash Redis 등 공유 저장소로 교체할 것.
 */

const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function limitPerMinute(): number {
  const raw = Number(process.env.RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function checkRateLimit(key: string): RateLimitResult {
  const limit = limitPerMinute();
  const now = Date.now();

  // 만료된 버킷 정리 (메모리 누수 방지)
  if (buckets.size > 5_000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  bucket.count += 1;

  if (bucket.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, remaining: limit - bucket.count, retryAfterSec: 0 };
}

/** 프록시 뒤에서 클라이언트 IP 추출 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown';
  return req.headers.get('x-real-ip') ?? 'unknown';
}
