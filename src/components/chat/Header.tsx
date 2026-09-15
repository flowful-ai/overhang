"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import { Settings, Cpu, ChevronDown, Globe } from "lucide-react";
import ThemeToggle from "../ThemeToggle";
import { MODELS, modelSupportsWebSearch } from "@/lib/utils";
import { usePopoverDismiss } from "./hooks/use-popover-dismiss";
import { webSearchToggleState } from "./web-search-preference";

// App header: logo, model dropdown, theme toggle, and settings popover (model,
// web search). Each popover owns its open/closed state; dismissal (outside
// click and Escape) is handled locally by usePopoverDismiss.
export default function Header({
  model, setModel, webSearch, setWebSearch, webSearchAvailable,
}: {
  model: string;
  setModel: (m: string) => void;
  /** The user's web search preference. */
  webSearch: boolean;
  setWebSearch: (enabled: boolean) => void;
  /** False when the server has web search off: the toggle is shown disabled. */
  webSearchAvailable: boolean;
}) {
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const settingsRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Close each header menu on outside click or Escape. Setters from useState
  // are referentially stable, so these closers don't churn the listeners.
  const closeSettings = useCallback(() => setShowSettings(false), []);
  const closeModelMenu = useCallback(() => setShowModelMenu(false), []);
  usePopoverDismiss(settingsRef, showSettings, closeSettings);
  usePopoverDismiss(modelMenuRef, showModelMenu, closeModelMenu);

  const searchToggle = webSearchToggleState({
    serverAvailable: webSearchAvailable,
    modelSupported: modelSupportsWebSearch(model),
    preference: webSearch,
  });

  return (
    <header className="flex items-center justify-between px-6 py-4 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 shadow-sm z-30 h-16 shrink-0">
      <div className="flex items-center gap-3">
        <Image src="/favicon.svg" alt="" aria-hidden="true" width={40} height={40} className="w-10 h-10" />
        <div className="flex flex-col leading-tight">
          <h1 className="text-xl font-bold text-primary-600 dark:text-primary-400">Overhang</h1>
          <a
            href="https://flowful.ai"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
          >
            by flowful.ai
          </a>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="hidden md:block relative" ref={modelMenuRef}>
          <button
            onClick={() => setShowModelMenu((v) => !v)}
            className={`flex items-center gap-2 text-sm px-2 py-1.5 rounded-lg transition-colors ${
              showModelMenu
                ? "bg-primary-50 dark:bg-primary-950/40 text-primary-600 dark:text-primary-400"
                : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            }`}
            aria-haspopup="menu"
            aria-expanded={showModelMenu}
          >
            <Cpu className="w-4 h-4" />
            <span>{MODELS.find((m) => m.id === model)?.name || model}</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showModelMenu ? "rotate-180" : ""}`} />
          </button>
          {showModelMenu && (
            <div
              role="menu"
              className="absolute top-full left-0 mt-2 w-56 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-800 py-1 animate-in slide-in-from-top-2 z-50"
            >
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setModel(m.id);
                    setShowModelMenu(false);
                  }}
                  role="menuitem"
                  className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-sm transition-colors ${
                    m.id === model
                      ? "text-primary-700 dark:text-primary-300 bg-primary-50 dark:bg-primary-950/40"
                      : "text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <ThemeToggle />
        <div className="relative" ref={settingsRef}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-2 rounded-lg transition-colors ${showSettings ? "bg-primary-50 dark:bg-primary-950/40 text-primary-600 dark:text-primary-400" : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"}`}
            aria-label="Settings"
            aria-haspopup="menu"
            aria-expanded={showSettings}
          >
            <Settings className="w-5 h-5" />
          </button>
          {showSettings && (
            <div className="absolute top-full right-0 mt-2 w-64 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-800 p-4 space-y-2 animate-in slide-in-from-top-2 z-50">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-200 block">AI Model</label>
              <div className="relative">
                <Cpu className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500 pointer-events-none" />
                <select
                  className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-primary-500 focus:outline-none appearance-none bg-white dark:bg-gray-900"
                  aria-label="AI Model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between gap-3 pt-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Globe className="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
                  <div className="leading-tight">
                    <span id="web-search-label" className="text-sm font-medium text-gray-700 dark:text-gray-200 block">
                      Web search
                    </span>
                    <span id="web-search-hint" className="text-[11px] text-gray-400 dark:text-gray-500 block">
                      {searchToggle.hint}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-labelledby="web-search-label"
                  aria-describedby="web-search-hint"
                  aria-checked={searchToggle.checked}
                  // aria-disabled, not disabled: the switch stays in the tab
                  // order so keyboard users reach the hint explaining why.
                  aria-disabled={searchToggle.disabled || undefined}
                  onClick={() => {
                    // Space and Enter on a button fire click, so this covers keys too.
                    if (!searchToggle.disabled) setWebSearch(!webSearch);
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${
                    searchToggle.checked ? "bg-primary-600" : "bg-gray-300 dark:bg-gray-700"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                      searchToggle.checked ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
