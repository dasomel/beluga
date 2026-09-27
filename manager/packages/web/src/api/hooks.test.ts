import { afterEach, describe, expect, it, vi } from 'vitest';
import { warnIfTruncated } from './hooks';

// hooks.ts의 list hook들은 페이지네이션 UI 없이 고정된 LIST_PAGE_SIZE(=서버 pageSize
// 상한인 100)만 요청한다(hooks.ts 상단 주석). meta.total이 100을 넘으면 나머지 항목이
// 아무 신호 없이 조용히 사라진다(issue #43 finding #5). warnIfTruncated는 그 사실을
// 콘솔 경고로 드러낸다 -- pageSize UI 자체를 새로 설계하지는 않는다.
describe('warnIfTruncated', () => {
  afterEach(() => vi.restoreAllMocks());

  it('meta.total이 data.length보다 크면 잘림을 console.warn으로 알린다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnIfTruncated('services', {
      data: new Array(100).fill({}),
      meta: { total: 137, page: 1, pageSize: 100 },
    });

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('services'));
    expect(warnSpy.mock.calls[0]?.[0]).toContain('100');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('137');
  });

  it('meta.total이 data.length 이하이면 경고하지 않는다', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    warnIfTruncated('services', {
      data: new Array(3).fill({}),
      meta: { total: 3, page: 1, pageSize: 100 },
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
