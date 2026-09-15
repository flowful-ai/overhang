"use client";

import { useState, useCallback } from "react";
import ChatInterface from "./ChatInterface";
import ErrorBoundary from "@/components/ErrorBoundary";
import { STORAGE_KEY } from "./constants";

export default function AppWorkspace({ webSearchAvailable }: { webSearchAvailable: boolean }) {
  const [key, setKey] = useState(0);

  const handleReset = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setKey(k => k + 1);
  }, []);

  return (
    <ErrorBoundary onReset={handleReset}>
      <ChatInterface key={key} webSearchAvailable={webSearchAvailable} />
    </ErrorBoundary>
  );
}
