// @ts-check

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class Dialog {
  /** @param {HTMLElement} overlay @param {HTMLElement} appShell */
  constructor(overlay, appShell) {
    this.overlay = overlay;
    /** @type {HTMLElement} */
    this.dialog = overlay.querySelector('[role="dialog"]');
    this.appShell = appShell;
    /** @type {HTMLElement} */
    this.title = overlay.querySelector("#modal-title");
    /** @type {HTMLElement} */
    this.body = overlay.querySelector("#modal-body");
    /** @type {HTMLButtonElement} */
    this.cancelButton = overlay.querySelector("#modal-cancel");
    /** @type {HTMLButtonElement} */
    this.okButton = overlay.querySelector("#modal-ok");
    /** @type {HTMLButtonElement} */
    this.closeButton = overlay.querySelector("#modal-close");
    this.previousFocus = null;
    this.resolve = null;

    this.closeButton.addEventListener("click", () => this.close(false));
    this.cancelButton.addEventListener("click", () => this.close(false));
    this.okButton.addEventListener("click", () => this.close(true));
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) this.close(false);
    });
    overlay.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  /** @param {string} title @param {string|Node} content @param {{confirm?:boolean, okLabel?:string}} [options] */
  open(title, content, options = {}) {
    if (!this.overlay.hidden) this.close(false);
    this.previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.title.textContent = title;
    this.body.replaceChildren();
    if (typeof content === "string") this.body.textContent = content;
    else this.body.append(content);
    this.cancelButton.hidden = !options.confirm;
    this.okButton.textContent =
      options.okLabel || (options.confirm ? "确认" : "完成");
    this.overlay.hidden = false;
    this.appShell.inert = true;
    window.requestAnimationFrame(() => this.dialog.focus());
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  confirm(title, content, okLabel = "确认") {
    return this.open(title, content, { confirm: true, okLabel });
  }

  close(result) {
    if (this.overlay.hidden) return;
    this.overlay.hidden = true;
    this.appShell.inert = false;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(Boolean(result));
    this.previousFocus?.focus();
  }

  onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      /** @type {NodeListOf<HTMLElement>} */ (
        this.dialog.querySelectorAll(FOCUSABLE)
      ),
    ).filter((item) => !item.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
