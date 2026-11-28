import type { HealthStatus } from '@beluga-manager/domain-api/schema';
import type { Translations } from '../../i18n/translations';
import type { GraphEdgeAccent } from './theme';

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
  /** `false` disables the dashed-edge animation (declared flows must not look like live traffic); `true` cannot force it. */
  animated?: boolean;
  /** SVG dash pattern for a dashed edge (e.g. '2,4'); defaults to '5,5'. Pair with `accent` so meaning is never colour-only. */
  dashPattern?: string;
  /** Accent stroke colour; defaults to the neutral edge token. */
  accent?: GraphEdgeAccent;
  /** Keep `label` for the accessible name and the table view but do not draw it on the canvas. */
  hideLabel?: boolean;
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
  /** Lowest zoom `fitView` may use; xyflow defaults to 0.5, too high for wide graphs. */
  minZoom?: number;
  /** `fitView` padding (fraction of the viewport); defaults to 0.3. */
  fitViewPadding?: number;
}
