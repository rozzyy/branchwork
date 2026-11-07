export type FilesIntent = { type: "files.open"; path: string };

export function dispatchFilesIntent(intent: FilesIntent): void {
  window.dispatchEvent(new CustomEvent("branchwork:files-intent", { detail: intent }));
}
