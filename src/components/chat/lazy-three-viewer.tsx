"use client";

import dynamic from "next/dynamic";

// three / react-three-fiber / drei are the heaviest part of /app and are only
// needed once there is a model to show, so keep them out of the first load.
// React 19 passes `ref` as a regular prop, which next/dynamic forwards to the
// loaded forwardRef component.
const loadThreeDViewer = () => import("../ThreeDViewer");

const ThreeDViewer = dynamic(loadThreeDViewer, {
  ssr: false,
  loading: () => <div className="h-full w-full bg-gray-50 dark:bg-gray-900" />,
});

// Warm the chunk ahead of the first model (when an agent turn starts), so the
// viewer is ready by the time the tool call returns an STL.
export function preloadThreeDViewer() {
  void loadThreeDViewer();
}

export default ThreeDViewer;
