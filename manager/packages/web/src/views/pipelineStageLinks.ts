import type { Service } from '@beluga-manager/domain-api/schema';
import { getSafeExternalUrl } from './safeExternalUrl';

export function getStageExternalUrl(serviceId: string, services: Service[]): string | null {
  const service = services.find((candidate) => candidate.id === serviceId);
  return getSafeExternalUrl(service?.endpoint);
}
