(() => {
  const storageKey = "cnt-lab-theme";
  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const themeColors = { light: "#f3f5f0", dark: "#081b1a" };
  const readStoredTheme = () => {
    try { const value = localStorage.getItem(storageKey); return value === "light" || value === "dark" ? value : null; }
    catch { return null; }
  };
  const syncControls = (theme) => {
    const nextLabel = theme === "dark" ? "浅色" : "深色";
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.setAttribute("aria-label", `切换到${nextLabel}模式`);
      button.setAttribute("title", `切换到${nextLabel}模式`);
      button.setAttribute("aria-pressed", String(theme === "dark"));
      const icon = button.querySelector("[data-theme-icon]");
      const label = button.querySelector("[data-theme-label]");
      if (icon) icon.textContent = theme === "dark" ? "☀" : "☾";
      if (label) label.textContent = nextLabel;
    });
  };
  const applyTheme = (theme, persist = false) => {
    root.dataset.theme = theme; root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColors[theme]);
    syncControls(theme);
    if (persist) { try { localStorage.setItem(storageKey, theme); } catch { /* no-op */ } }
    document.dispatchEvent(new CustomEvent("cntlab:themechange", { detail: { theme } }));
  };
  applyTheme(readStoredTheme() || (systemTheme.matches ? "dark" : "light"));
  const connectControls = () => {
    syncControls(root.dataset.theme);
    document.querySelectorAll("[data-theme-toggle]").forEach((button) => button.addEventListener("click", () => applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true)));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connectControls, { once: true }); else connectControls();
  systemTheme.addEventListener?.("change", (event) => { if (!readStoredTheme()) applyTheme(event.matches ? "dark" : "light"); });
})();
