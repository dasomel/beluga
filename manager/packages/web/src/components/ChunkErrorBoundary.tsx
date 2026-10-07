import React from 'react';
import { RefreshCw } from 'lucide-react';
import { SqlStatic } from './SqlStatic';

export interface ChunkErrorBoundaryProps {
  value: string;
  label: string;
  failedLabel: string;
  retryLabel: string;
  onRetry: () => void;
  children: React.ReactNode;
}

// D1: a failed dynamic import (deploy hash mismatch, offline) rejects React.lazy and, without a
// boundary, unmounts the whole app. The fallback is the eager plain SQL (readable, copyable)
// plus a status message and a retry. Nothing is logged: the error may carry URLs, not secrets,
// but there is nothing the user can act on in it.
export class ChunkErrorBoundary extends React.Component<ChunkErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  retry = () => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div>
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 font-medium">
          <span role="status">{this.props.failedLabel}</span>
          <button
            type="button"
            onClick={this.retry}
            className="inline-flex items-center gap-1 font-bold underline focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500 rounded px-1"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            {this.props.retryLabel}
          </button>
        </div>
        <SqlStatic value={this.props.value} label={this.props.label} />
      </div>
    );
  }
}
