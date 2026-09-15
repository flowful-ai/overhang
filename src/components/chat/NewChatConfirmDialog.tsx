"use client";

import Dialog from "./Dialog";

// New Chat confirm (UX audit #15): only shown when there's a conversation to
// lose. An empty thread resets instantly.
export default function NewChatConfirmDialog({
  open, onClose, onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="new-chat-confirm-title"
      className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-[90vw] max-w-sm p-6 space-y-4"
    >
      <h2 id="new-chat-confirm-title" className="text-lg font-semibold text-gray-800 dark:text-gray-100">
        Start a new chat?
      </h2>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        This clears the current conversation and model.
      </p>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="px-3 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
        >
          Start new chat
        </button>
      </div>
    </Dialog>
  );
}
