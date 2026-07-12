// @ts-check

export class ToastRegion {
  /** @param {HTMLElement} element @param {HTMLElement} liveRegion */
  constructor(element, liveRegion) {
    this.element = element;
    this.liveRegion = liveRegion;
  }

  /** @param {string} message @param {'success'|'warning'|'error'} [kind] */
  show(message, kind = "success") {
    this.liveRegion.textContent = message;
    const toast = document.createElement("div");
    toast.className = `toast${kind === "warning" ? " is-warning" : ""}${kind === "error" ? " is-error" : ""}`;
    toast.textContent = message;
    this.element.appendChild(toast);
    const duration = kind === "error" ? 5400 : 3600;
    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 200);
    }, duration);
  }
}
