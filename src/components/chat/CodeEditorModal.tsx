"use client";

import { useState } from "react";
import { Download, X, Copy, Check } from "lucide-react";

import CodeEditor from "./lazy-code-editor";
import Dialog from "./Dialog";
import RerenderButton from "./RerenderButton";
import { useToasts } from "./toasts";
import { triggerBlobDownload } from "./download";
import { useDesignSession } from "./design-session";

// Full-screen code editor dialog with copy / save / re-render actions.
export default function CodeEditorModal({
  open, onClose, isRunning,
}: {
  open: boolean;
  onClose: () => void;
  isRunning: boolean;
}) {
  const { workingCode, setWorkingCode, isRendering, isModified, rerender } = useDesignSession();
  const { toast } = useToasts();
  const [codeCopied, setCodeCopied] = useState(false);

  const handleCopyCode = async () => {
    if (!workingCode) return;
    // navigator.clipboard is undefined on non-HTTPS / unsupported contexts;
    // guard it and surface a manual-copy hint rather than failing silently.
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(workingCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      toast("Couldn't copy to clipboard. Select the code and copy manually.");
    }
  };

  const handleSaveCode = () => {
    if (!workingCode) return;
    const blob = new Blob([workingCode], { type: "text/x-python" });
    triggerBlobDownload(blob, "model.py");
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="code-editor-title"
      className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-[90vw] h-[85vh] max-w-5xl flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
        <h2 id="code-editor-title" className="text-lg font-semibold text-gray-800 dark:text-gray-100">
          Code Editor {isModified && <span className="text-amber-500 dark:text-amber-400 text-sm font-normal ml-2">(modified)</span>}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyCode}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Copy code to clipboard"
          >
            {codeCopied ? <Check className="w-4 h-4 text-green-600 dark:text-green-400" /> : <Copy className="w-4 h-4" />}
            {codeCopied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={handleSaveCode}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Download as model.py"
          >
            <Download className="w-4 h-4" />
            Save
          </button>
          <RerenderButton
            onClick={async () => {
              // Only close on a successful render, so a failed edit keeps
              // the editor open on the code that failed.
              if ((await rerender()).outcome === "rendered") onClose();
            }}
            isRendering={isRendering}
            disabled={isRendering || isRunning}
            title="Re-render and close"
            iconClassName="w-4 h-4"
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              !(isRendering || isRunning) ? "bg-primary-600 hover:bg-primary-700 text-white" : "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed"
            }`}
          />
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden bg-[#1e1e1e]">
        <CodeEditor code={workingCode} onChange={(val) => setWorkingCode(val || "")} readOnly={false} />
      </div>
    </Dialog>
  );
}
