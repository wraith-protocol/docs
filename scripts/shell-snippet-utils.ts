export function replaceShellPlaceholders(code: string): string {
  // Treat documentation placeholders as arguments, not shell redirections.
  return code.replace(/<[A-Za-z0-9_-]+>/g, "placeholder");
}
