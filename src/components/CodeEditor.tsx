"use client";

import { useMemo } from "react";
import { Editor } from "@monaco-editor/react";

interface CodeEditorProps {
  code: string;
  onChange?: (value: string | undefined) => void;
  readOnly?: boolean;
}

// Controlled through @monaco-editor/react's `value` prop. The library applies
// an external change with executeEdits + pushUndoStop, and only when the value
// differs from the model, so the user's own keystrokes (echoed back through
// onChange) are a no-op: no cursor jump, and undo history survives edits made
// elsewhere (e.g. a parameter slider).
export default function CodeEditor({ code, onChange, readOnly = true }: CodeEditorProps) {
  // Stable options: a fresh object every render makes the editor call
  // updateOptions on each keystroke.
  const options = useMemo(
    () => ({
      readOnly,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 8, bottom: 8 },
      scrollbar: {
        vertical: "auto" as const,
        horizontal: "auto" as const,
      },
    }),
    [readOnly],
  );

  return (
    <div className="h-full w-full overflow-hidden">
      <Editor
        height="100%"
        defaultLanguage="python"
        theme="vs-dark"
        value={code}
        onChange={onChange}
        options={options}
      />
    </div>
  );
}
