import type { HealthStatus } from '@beluga-manager/domain-api/schema';
import type { Translations } from '../../i18n/translations';

export interface TopologyGraphNode {
  id: string;
  title: string;
  subtitle: string;
  status?: HealthStatus;
  badge?: string;
  detail?: string | null;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  ariaLabel?: string;
}

export interface TopologyGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  dashed?: boolean;
  confidence?: number;
  method?: string;
  evidence?: readonly string[];
}

export interface TopologyGraphProps {
  t: Translations;
  theme?: 'light' | 'dark';
  nodes: readonly TopologyGraphNode[];
  edges: readonly TopologyGraphEdge[];
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  isLoading?: boolean;
  error?: Error | null;
  emptyMessage?: string;
  height?: number | string;
  className?: string;
  ariaLabel?: string;
}
