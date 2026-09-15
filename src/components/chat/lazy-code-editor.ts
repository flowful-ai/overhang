"use client";

import dynamic from "next/dynamic";

// Monaco is heavy and browser-only; load it lazily on the client. Shared by
// MessageList and CodeEditorModal so both reference the same dynamic wrapper
// (and chunk) instead of each declaring their own copy.
const CodeEditor = dynamic(() => import("../CodeEditor"), { ssr: false });

export default CodeEditor;
