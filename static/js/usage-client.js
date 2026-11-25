/* Daily, per-tool browser counts. No traffic on page views or offline copies. */
(() => {
  "use strict";
  const tool = document.documentElement.dataset.usageTool;
  const gateway = "https://cnt-vision.47.236.76.214.nip.io";
  const host = location.hostname;
  if (location.protocol !== "https:" || !tool || navigator.globalPrivacyControl) return;
  if (host !== "zuestian.github.io" && host !== "47.236.76.214.nip.io" && !host.endsWith(".47.236.76.214.nip.io")) return;
  const sameOrigin = ["tem", "production"].includes(tool) && host !== "zuestian.github.io";
  const endpoint = (sameOrigin ? "" : gateway) + "/api/usage/record";
  const key = "cnt-usage-v1/" + tool;
  const beijingDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  let busy = false;

  function stored() {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function prepare(day) {
    let record = stored();
    if (record?.day !== day || !record.visitor) {
      record = { day, visitor: crypto.randomUUID(), sent: false };
      localStorage.setItem(key, JSON.stringify(record));
    }
    return record;
  }
  async function recordUse() {
    if (busy) return;
    busy = true;
    try {
      const day = beijingDay();
      const entry = navigator.locks
        ? await navigator.locks.request(key, () => prepare(day))
        : prepare(day);
      if (entry.sent) return;
      const body = new URLSearchParams({ tool, day, visitor: entry.visitor });
      const response = await fetch(endpoint, { method: "POST", body, credentials: "omit", referrerPolicy: "origin", keepalive: true });
      if (response.ok && stored()?.visitor === entry.visitor) {
        localStorage.setItem(key, JSON.stringify({ ...entry, sent: true }));
      }
    } catch { /* Storage or network restrictions must never interrupt the tool. */ }
    finally { busy = false; }
  }
  function retryPending() {
    const pending = stored();
    if (pending?.day === beijingDay() && !pending.sent) recordUse();
  }
  // Imports that can also originate from detached pickers or from the clipboard.
  document.addEventListener("cnt-data-imported", recordUse);
  window.addEventListener("online", retryPending);
  retryPending();

  const clicks = {
    vision: "#applyScale, #sendQuestion",
    opt: "#analyzeButton, #previewButton, #applyScaleButton, #startComparisonButton, [data-export]",
    tem: "#btn-run-yolo, #btn-apply-scale, #btn-auto-scale, #btn-apply-preprocess, #btn-batch-confirm, #btn-batch-summary, #btn-export-csv, #btn-report",
    sem: "#btn-run-analysis, #btn-auto-scale, #btn-apply-scale, #btn-export-csv",
    grain: "#fitActiveButton, #fitVisibleButton, #sampleButton, #exportButton",
    uv: "#calculateButton, #batchButton, #loadSample, #recordButton, #exportButton",
    raman: "#analyzeButton, #batchButton, #sampleButton, #detectButton, #refitButton, #exportFileButton, #exportBatchButton, #exportPngButton",
    xrd: "#fit, #demo, #useFTGroups, #export, #exportBrief, #exportPoints, #plotPNG, #tubePNG, #saveCompare, #copyCompare, #copyBatch",
    bet: "#quickRun, #predictRun, #explainRun, #whatIfRun, #resistivityRun, #batchPreviewRun, #batchPredictRun, #inverseRun",
    production: ".primary-nav a, .mobile-nav a, .chart-actions button, .chart-details summary, .chart-canvas, .workspace .el-table__row, .workspace button.el-button, .desktop-filters .el-segmented__item, .el-select-dropdown__item, .el-date-table td.available",
    furnace: "a.dataset-link",
  };
  document.addEventListener("click", event => {
    if (!event.isTrusted || !clicks[tool]) return;
    const target = event.target.closest?.(clicks[tool]);
    if (target && !target.closest(":disabled, [aria-disabled=true], .is-disabled")) recordUse();
  }, true);
  document.addEventListener("auxclick", event => {
    if (tool === "furnace" && event.isTrusted && event.button === 1 && event.target.closest?.("a.dataset-link")) recordUse();
  });
  document.addEventListener("drop", event => {
    if (tool === "tem" && event.isTrusted && event.target.closest?.("#canvas-container") && event.dataTransfer?.files.length) recordUse();
  }, true);
  document.addEventListener("change", event => {
    if (event.isTrusted && event.target.matches?.("input[type=file]") && event.target.files?.length) recordUse();
  }, true);
  document.addEventListener("input", event => {
    if (tool === "furnace" && event.isTrusted && event.target.id === "search" && event.target.value.trim()) recordUse();
  });
})();
