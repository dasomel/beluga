import { useQuery } from '@tanstack/react-query';
import type { Event, Pipeline, Service } from '@beluga-manager/domain-api/schema';
import { useApiBaseUrl } from '../config/ConfigContext';
import { apiGet } from './client';
import type { DomainApiHealthResponse, ListEnvelope } from './types';

// 이 콘솔이 다루는 서비스/파이프라인 개수는 작아서(스텁 데이터 기준 한 자릿수) 페이지네이션
// UI 없이 큰 pageSize로 한 번에 받는다 -- 서버 쪽 페이지네이션 자체(#43)를 무시하는 것은
// 아니고, 그 UI를 이 태스크 범위에 넣지 않은 것뿐이다.
const LIST_PAGE_SIZE = 100;

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
    queryFn: () => apiGet<ListEnvelope<Service>>(baseUrl, `/api/v1/services?pageSize=${LIST_PAGE_SIZE}`),
  });
}

export function usePipelines() {
  const baseUrl = useApiBaseUrl();
  return useQuery({
    queryKey: ['pipelines'],
    queryFn: () => apiGet<ListEnvelope<Pipeline>>(baseUrl, `/api/v1/pipelines?pageSize=${LIST_PAGE_SIZE}`),
  });
}

export function useEvents() {
  const baseUrl = useApiBaseUrl();
  return useQuery({
    queryKey: ['events'],
    queryFn: () => apiGet<ListEnvelope<Event>>(baseUrl, `/api/v1/events?pageSize=${LIST_PAGE_SIZE}`),
  });
}
