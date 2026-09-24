"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Camera, Save, ChevronDown } from "lucide-react";
import type { ThreeDViewerRef } from "../ThreeDViewer";
import ThreeDViewer, { preloadThreeDViewer } from "./lazy-three-viewer";
import ErrorBoundary from "../ErrorBoundary";
import ParametersPanel from "../ParametersPanel";
import RerenderButton from "./RerenderButton";
import { parseParameters } from "@/lib/parameters";
import { base64ToBlob, APP_CONSTANTS } from "@/lib/utils";
import { useToasts } from "./toasts";
import { usePopoverDismiss } from "./hooks/use-popover-dismiss";
import { triggerBlobDownload, type WindowWithSavePicker } from "./download";
import { postJson } from "./api";
import { useDesignSession } from "./design-session";

// The 3D viewer overlay: rendered model, parameters panel, snapshot button,
// and the export menu (STL / 3MF / save-for-slicer). The export menu owns its
// open state; dismissal (outside click and Escape) is handled locally by
// usePopoverDismiss.
export default function ViewerPane({
  mobileTab, isDesktop, isRunning, setPendingImage,
}: {
  mobileTab: "chat" | "model";
  isDesktop: boolean;
  isRunning: boolean;
  setPendingImage: (img: string | null) => void;
}) {
  const {
    currentCode, displayedStl, workingCode, setWorkingCode, isRendering, isModified, rerender, needsRerender, restoreFailed,
  } = useDesignSession();
  const { toast } = useToasts();

  const [viewerKey, setViewerKey] = useState(0);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const viewerRef = useRef<ThreeDViewerRef>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Load the viewer chunk as soon as a model is on its way (an agent turn, or
  // a restored thread's automatic re-render) rather than when the STL arrives.
  const expectingModel = isRunning || !!currentCode;
  useEffect(() => {
    if (expectingModel) preloadThreeDViewer();
  }, [expectingModel]);

  // Parameters panel open state lives here so it survives the panel
  // remounting, and so the panel opens by itself the first time a model with
  // parameters appears (desktop only: on a phone it would cover most of the
  // viewer). After that the user's choice sticks until New Chat clears the
  // working copy. Render-time adjustment, no effect.
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [paramsAutoOpened, setParamsAutoOpened] = useState(false);
  const hasParams = useMemo(() => parseParameters(workingCode).length > 0, [workingCode]);
  if (!paramsAutoOpened && hasParams && displayedStl) {
    setParamsAutoOpened(true);
    setParamsExpanded(isDesktop);
  } else if (paramsAutoOpened && !workingCode) {
    setParamsAutoOpened(false);
    setParamsExpanded(false);
  }

  const closeExportMenu = useCallback(() => setShowExportMenu(false), []);
  usePopoverDismiss(exportMenuRef, showExportMenu, closeExportMenu);

  const handleViewerReset = useCallback(() => {
    setViewerKey((prev) => prev + 1);
  }, []);

  const handleDownload = () => {
    if (!displayedStl) return;
    try {
      const blob = base64ToBlob(displayedStl, APP_CONSTANTS.STL_MIME_TYPE);
      triggerBlobDownload(blob, "model.stl");
    } catch { /* ignore */ }
    setShowExportMenu(false);
  };

  const handleDownload3MF = async () => {
    if (!workingCode) return;
    setShowExportMenu(false);
    // The 3MF is generated from the working code. If the user has un-rendered
    // edits, render them first so the export always matches what the viewer
    // shows — otherwise a dirty working copy would silently export geometry
    // the user has never seen (the STL download, by contrast, ships the
    // already-displayed mesh).
    let code = workingCode;
    if (isModified) {
      const result = await rerender();
      if (result.outcome === "busy") {
        toast("A render is already in progress - try again in a moment.");
        return;
      }
      // "failed" already surfaced the server's error via rerender()'s own
      // toast; "superseded" means the design moved on underneath. Both mean
      // "don't export this", and neither needs a second, vaguer toast here.
      if (result.outcome !== "rendered") return;
      // Export what was RENDERED, not the snapshot captured before the await:
      // the render loop follows edits made while it was in flight, so those
      // can differ, and exporting the snapshot would ship geometry the viewer
      // never showed — the mismatch this gate exists to prevent.
      code = result.code;
    }
    try {
      const data = await postJson<{ threemfBase64: string }>("/api/export-3mf", { code });
      const blob = base64ToBlob(data.threemfBase64, "model/3mf");
      triggerBlobDownload(blob, "model.3mf");
    } catch {
      toast("3MF export failed. Please try again.");
    }
  };

  const handleSaveForSlicer = async () => {
    if (!displayedStl) return;
    let blob: Blob;
    try {
      blob = base64ToBlob(displayedStl, APP_CONSTANTS.STL_MIME_TYPE);
    } catch {
      setShowExportMenu(false);
      return;
    }
    if ("showSaveFilePicker" in window) {
      try {
        const picker = (window as unknown as WindowWithSavePicker).showSaveFilePicker;
        const fileHandle = await picker({
          suggestedName: "model.stl",
          types: [{ description: "STL File", accept: { "application/sla": [".stl"] } }],
        });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        setShowExportMenu(false);
        return;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          setShowExportMenu(false);
          return;
        }
      }
    }
    triggerBlobDownload(blob, "model.stl");
    setShowExportMenu(false);
  };

  const handleSnapshot = () => {
    if (viewerRef.current) {
      const dataUrl = viewerRef.current.takeSnapshot();
      if (dataUrl) {
        setPendingImage(dataUrl);
        // The attachment chip lands in the composer, which can be below the
        // fold (or on the other mobile tab), so confirm the capture in place.
        toast("Snapshot attached to prompt", "success");
      }
    }
  };

  // Viewer placeholder for a restored session: the design session re-renders
  // automatically; the button is the fallback when that fails.
  const restoreEmptyState = (
    <div className="flex flex-col items-center gap-3 px-6 text-center">
      <p role="status" aria-live="polite" className="text-sm">
        {restoreFailed ? "Couldn't reload your previous model." : "Reloading your previous model..."}
      </p>
      <RerenderButton
        onClick={() => void rerender()}
        isRendering={isRendering}
        disabled={isRendering || isRunning}
        iconClassName="w-3.5 h-3.5"
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-primary-600 hover:bg-primary-700 text-white shadow-sm disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-500 dark:disabled:text-gray-400 disabled:cursor-not-allowed disabled:shadow-none"
      />
    </div>
  );

  return (
    <div className={`${mobileTab === "model" ? "block" : "hidden"} md:block flex-1 bg-gray-100 dark:bg-gray-800 relative min-w-0`}>
      <div className="absolute inset-4 bg-white dark:bg-gray-900 rounded-2xl shadow-sm overflow-hidden border border-gray-200 dark:border-gray-800">
        <ErrorBoundary onReset={handleViewerReset}>
          {displayedStl ? (
            // frameKey: the camera re-frames for each new agent design, not
            // when a parameter edit re-renders the same one.
            <ThreeDViewer key={viewerKey} ref={viewerRef} stlBase64={displayedStl} frameKey={currentCode} />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900 text-gray-400 dark:text-gray-400">
              {needsRerender ? restoreEmptyState : <p>Your 3D design will appear here</p>}
            </div>
          )}
        </ErrorBoundary>

        {/* Stays visible (disabled) during a turn instead of vanishing. */}
        {displayedStl && workingCode && (
          // Below sm the panel sits under the Snapshot/Export buttons instead
          // of beside them, so expanding it never hides those controls.
          <div className="absolute top-16 left-4 sm:top-4 z-10">
            <ParametersPanel
              code={workingCode}
              onCodeChange={setWorkingCode}
              onRerender={rerender}
              dirty={isModified}
              isRendering={isRendering}
              disabled={isRunning}
              expanded={paramsExpanded}
              onExpandedChange={setParamsExpanded}
            />
          </div>
        )}

        {displayedStl && (
          <div className="absolute top-4 right-4 z-10 flex gap-2">
            <button
              onClick={handleSnapshot}
              className="flex items-center gap-2 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 sm:px-4 py-2 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 text-sm font-medium transition-colors"
              title="Take Snapshot"
              aria-label="Take snapshot"
            >
              <Camera className="w-4 h-4" />
              <span className="hidden sm:inline">Snapshot</span>
            </button>
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setShowExportMenu(!showExportMenu)}
                className="flex items-center gap-2 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 sm:px-4 py-2 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 text-sm font-medium transition-colors"
                aria-haspopup="menu"
                aria-expanded={showExportMenu}
                aria-label="Export"
                title="Export"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Export</span>
                <ChevronDown className={`w-4 h-4 transition-transform ${showExportMenu ? "rotate-180" : ""}`} />
              </button>
              {showExportMenu && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-800 py-1 z-20">
                  <button onClick={handleDownload} className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <Download className="w-4 h-4" />
                    <div className="text-left">
                      <div className="font-medium">Download STL</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Universal mesh format</div>
                    </div>
                  </button>
                  <button onClick={handleDownload3MF} className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <Download className="w-4 h-4" />
                    <div className="text-left">
                      <div className="font-medium">Download 3MF</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Modern format with metadata</div>
                    </div>
                  </button>
                  <button onClick={handleSaveForSlicer} className="w-full flex items-center gap-3 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <Save className="w-4 h-4" />
                    <div className="text-left">
                      <div className="font-medium">Save for Slicer</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">Choose save location</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
