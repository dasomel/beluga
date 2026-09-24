import { useQuery } from '@tanstack/react-query';
import type { Event, Pipeline, Service } from '@beluga-manager/domain-api/schema';
import { useApiBaseUrl } from '../config/ConfigContext';
import { apiGet } from './client';
import type { DomainApiHealthResponse, ListEnvelope } from './types';

// 이 콘솔이 다루는 서비스/파이프라인 개수는 작아서(스텁 데이터 기준 한 자릿수) 페이지네이션
// UI 없이 큰 pageSize로 한 번에 받는다 -- 서버 쪽 페이지네이션 자체(#43)를 무시하는 것은
// 아니고, 그 UI를 이 태스크 범위에 넣지 않은 것뿐이다.
const LIST_PAGE_SIZE = 100;

// LIST_PAGE_SIZE는 서버 pageSize 상한(schema/query.ts의 max(100))과 같다 -- 그 이상
// 항목이 있으면 이 hook들은 나머지를 조용히 드롭한다(issue #43 finding #5). 여기서
// pageSize UI를 새로 설계하지는 않고, 그 사실이 최소한 콘솔에는 보이도록 한다.
export function warnIfTruncated(resourceName: string, envelope: Pick<ListEnvelope<unknown>, 'data' | 'meta'>): void {
  if (envelope.meta.total > envelope.data.length) {
    console.warn(
      `[${resourceName}] showing ${envelope.data.length} of ${envelope.meta.total} items -- ` +
        `list is truncated at pageSize=${LIST_PAGE_SIZE} with no pagination UI`,
    );
  }
}

export function useDomainApiHealth() {
  const baseUrl = useApiBaseUrl();
  return useQuery({
    queryKey: ['domain-api-health'],
    queryFn: () => apiGet<DomainApiHealthResponse>(baseUrl, '/api/v1/health'),
  });
}

export function useServices() {
  const baseUrl = useApiBaseUrl();
  return useQuery({
    queryKey: ['services'],
    queryFn: async () => {
      const result = await apiGet<ListEnvelope<Service>>(baseUrl, `/api/v1/services?pageSize=${LIST_PAGE_SIZE}`);
      warnIfTruncated('services', result);
      return result;
    },
  });
}

export function usePipelines() {
  const baseUrl = useApiBaseUrl();
  return useQuery({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const result = await apiGet<ListEnvelope<Pipeline>>(baseUrl, `/api/v1/pipelines?pageSize=${LIST_PAGE_SIZE}`);
      warnIfTruncated('pipelines', result);
      return result;
    },
  });
}

export function useEvents() {
  const baseUrl = useApiBaseUrl();
  return useQuery({
    queryKey: ['events'],
    queryFn: async () => {
      const result = await apiGet<ListEnvelope<Event>>(baseUrl, `/api/v1/events?pageSize=${LIST_PAGE_SIZE}`);
      warnIfTruncated('events', result);
      return result;
    },
  });
}
