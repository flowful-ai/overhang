"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// three / react-three-fiber / drei are the heaviest part of /app and are only
// needed once there is a model to show, so keep them out of the first load.
// React 19 passes `ref` as a regular prop, which next/dynamic forwards to the
// loaded forwardRef component.
const loadThreeDViewer = () => import("../ThreeDViewer");

const ThreeDViewer = dynamic(loadThreeDViewer, {
  ssr: false,
  loading: () => (
    <div role="status" aria-live="polite" className="flex h-full w-full items-center justify-center gap-2 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400">
      <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
      <span className="text-sm">Loading viewer...</span>
    </div>
  ),
});

// Warm the chunk ahead of the first model, so the viewer is ready by the time
// an STL arrives. A failed preload is not an error by itself: the real load
// runs again when the viewer mounts and surfaces through its ErrorBoundary.
export function preloadThreeDViewer() {
  loadThreeDViewer().catch(() => {});
}

export default ThreeDViewer;
