// File System Access API typing (not in lib.dom yet).
export interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}
export interface WindowWithSavePicker {
  showSaveFilePicker: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
