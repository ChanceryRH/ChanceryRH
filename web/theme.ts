/* Appearance preference. "system" follows the OS; the choice is kept in this
   browser only. The stylesheet reads html[data-theme] and
   prefers-color-scheme, so this only has to set or clear the attribute. */
export type Theme = "system" | "light" | "dark";
const KEY = "chancery:theme";
const media = () =>
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function resolvedTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (media()?.matches ? "dark" : "light") : theme;
}
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolvedTheme(theme) === "dark" ? "#1b1924" : "#ffffff");
}
export function saveTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
  applyTheme(theme);
}
export function watchSystemTheme(onChange: () => void) {
  const m = media();
  m?.addEventListener("change", onChange);
  return () => m?.removeEventListener("change", onChange);
}
