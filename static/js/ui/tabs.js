// @ts-check

/** @param {HTMLElement} tablist @param {(panelId:string)=>void} [onChange] */
export function setupTabs(tablist, onChange) {
  const tabs = Array.from(
    /** @type {NodeListOf<HTMLElement>} */ (
      tablist.querySelectorAll('[role="tab"]')
    ),
  );
  const activate = (tab, focus = true) => {
    tabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(
        item.getAttribute("aria-controls") || "",
      );
      if (panel) panel.hidden = !active;
    });
    if (focus) tab.focus();
    onChange?.(tab.getAttribute("aria-controls") || "");
  };
  tabs.forEach((tab) =>
    tab.addEventListener("click", () => activate(tab, false)),
  );
  tablist.addEventListener("keydown", (event) => {
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    if (current < 0) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    activate(tabs[next]);
  });
  return { activate };
}
