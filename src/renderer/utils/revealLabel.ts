/** What the OS calls showing something in its file manager. */
export function revealInFolderLabel(platform: string = window.api.platform): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in file manager'
}

/** "Open a terminal here", named for the shell the host's terminals run (Git Bash on Windows). */
export function revealInTerminalLabel(platform: string): string {
  return platform === 'win32' ? 'Reveal in Git Bash' : 'Reveal in Terminal'
}
