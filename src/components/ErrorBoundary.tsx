"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

// A failed code-split chunk (e.g. the lazy 3D viewer on a flaky connection) is
// cached by the bundler for the life of the page, so re-mounting only replays
// the error; a full reload is the only real retry.
function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  return error.name === "ChunkLoadError" || /loading (css )?chunk|failed to (load|fetch dynamically imported)/i.test(error.message);
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    if (isChunkLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
          <div className="text-center space-y-4 max-w-md">
            <div className="flex justify-center">
              <div className="p-3 bg-red-100 dark:bg-red-900/40 rounded-full">
                <AlertTriangle className="w-8 h-8 text-red-600 dark:text-red-400" />
              </div>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">Something went wrong</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {this.state.error?.message || "An unexpected error occurred while rendering."}
              </p>
            </div>
            <button
              onClick={this.handleReset}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              {isChunkLoadError(this.state.error) ? "Reload page" : "Try Again"}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
