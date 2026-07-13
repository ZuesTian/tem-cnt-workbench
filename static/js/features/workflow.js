// @ts-check

import { $ } from "../ui/dom.js";

export class WorkflowController {
  constructor({
    store,
    api,
    viewer,
    dialog,
    toast,
    applySnapshot,
    refresh,
    onScaleApplied = () => {},
  }) {
    this.store = store;
    this.api = api;
    this.viewer = viewer;
    this.dialog = dialog;
    this.toast = toast;
    this.applySnapshot = applySnapshot;
    this.refresh = refresh;
    this.onScaleApplied = /** @type {(result:any) => unknown} */ (
      onScaleApplied
    );
    this.fileInput = $("#file-input");
    this.dropStage = $("#canvas-container");
    this.measurementQueue = Promise.resolve();
    this.scaleOverlayTimer = 0;
    this.maxUploadBytes = 50 * 1024 * 1024;

    ["#btn-open", "#btn-open-secondary", "#canvas-placeholder"].forEach(
      (selector) => {
        $(selector).addEventListener("click", () => this.openFilePicker());
      },
    );
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      if (file) this.upload(file);
      this.fileInput.value = "";
    });
    this.setupDropZone();

    $("#btn-auto-scale").addEventListener("click", () => this.autoScale());
    $("#btn-apply-scale").addEventListener("click", () => this.applyScale());
    $("#btn-set-scale").addEventListener("click", () => {
      this.viewer.setOverlays({ scaleBox: null });
      this.viewer.setMode("scale");
    });
    $("#btn-apply-preprocess").addEventListener("click", () =>
      this.preprocess(),
    );
    $("#btn-restore").addEventListener("click", () => this.restore());
    $("#btn-roi-mode").addEventListener("click", () =>
      this.viewer.setMode("roi"),
    );
    $("#btn-reset-roi").addEventListener("click", () => this.setRoi(null));
    $("#btn-pan-mode").addEventListener("click", () => {
      this.viewer.setOverlays({ scaleBox: null });
      this.viewer.setMode("pan");
    });
    $("#btn-measure-mode").addEventListener("click", () => {
      this.viewer.setOverlays({ scaleBox: null });
      this.viewer.setMode("measure");
    });
    $("#btn-fit").addEventListener("click", () => this.viewer.fitToWindow());
    $("#btn-zoom-in").addEventListener("click", () => this.viewer.zoomBy(1.2));
    $("#btn-zoom-out").addEventListener("click", () =>
      this.viewer.zoomBy(1 / 1.2),
    );
    $("#scale-nm").addEventListener("input", () => this.updateScaleButton());
    $("#scale-px").addEventListener("input", () => this.updateScaleButton());
    $("#show-boxes").addEventListener("change", (event) => {
      this.store.dispatch({
        type: "UI_PATCH",
        payload: { showBoxes: event.target.checked },
      });
    });
  }

  openFilePicker() {
    const task = this.store.getState().task;
    if (task && ["queued", "running", "cancelling"].includes(task.state)) {
      this.toast.show("分析进行中，请先取消或等待完成。", "warning");
      return;
    }
    this.fileInput.click();
  }

  setupDropZone() {
    ["dragenter", "dragover"].forEach((name) =>
      this.dropStage.addEventListener(name, (event) => {
        event.preventDefault();
        if (!this.store.getState().snapshot?.image)
          this.dropStage.classList.add("is-dragover");
      }),
    );
    ["dragleave", "drop"].forEach((name) =>
      this.dropStage.addEventListener(name, (event) => {
        event.preventDefault();
        this.dropStage.classList.remove("is-dragover");
      }),
    );
    this.dropStage.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) this.upload(file);
    });
  }

  async upload(file) {
    const allowed = /\.(tif|tiff|jpe?g|png|bmp)$/i.test(file.name);
    if (!allowed) {
      this.toast.show("请选择 PNG、JPG、TIFF 或 BMP 图像。", "warning");
      return;
    }
    if (file.size > this.maxUploadBytes) {
      this.toast.show(
        `图像文件不能超过 ${Math.round(this.maxUploadBytes / 1024 / 1024)} MB。`,
        "warning",
      );
      return;
    }
    this.store.dispatch({ type: "UI_PATCH", payload: { imageLoading: true } });
    try {
      this.viewer.setMode("pan");
      this.viewer.setOverlays({ scaleBox: null });
      $("#scale-px").value = "";
      this.setScaleMessage("尚未校准");
      const snapshot = await this.api.uploadImage(file);
      this.store.dispatch({ type: "RESET_IMAGE_STATE" });
      await this.applySnapshot(snapshot, { loadImage: true });
      await this.refresh({ session: false });
      this.toast.show("图像已载入，可继续设置比例尺。");
      return snapshot;
    } catch (error) {
      this.toast.show(error.message || "图像载入失败。", "error");
      return null;
    } finally {
      this.store.dispatch({
        type: "UI_PATCH",
        payload: { imageLoading: false },
      });
    }
  }

  async autoScale() {
    const button = $("#btn-auto-scale");
    try {
      this.viewer.setMode("pan");
      this.viewer.setOverlays({ scaleBox: null });
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      this.setScaleMessage("正在识别图中水平比例尺…");
      const result = await this.api.detectScale();
      if (!result.found) {
        this.viewer.setOverlays({ scaleBox: null });
        this.setScaleMessage("未识别到比例尺，请使用图上测量。", "warning");
        this.toast.show("未识别到清晰比例尺，请手工测量标尺两端。", "warning");
        return;
      }
      $("#scale-px").value = String(result.width_px);
      this.showScaleOverlay(result.bbox);
      this.setScaleMessage(
        `已识别水平标尺 ${result.width_px} px；请核对橙框（5 秒后自动隐藏）。`,
        "success",
      );
      this.updateScaleButton();
    } catch (error) {
      this.viewer.setOverlays({ scaleBox: null });
      this.setScaleMessage(error.message || "比例尺识别失败。", "error");
      this.toast.show(error.message || "比例尺识别失败。", "error");
    } finally {
      button.removeAttribute("aria-busy");
      button.disabled =
        !this.store.getState().snapshot?.image || this.isActive();
    }
  }

  async applyScale() {
    const nm = Number($("#scale-nm").value);
    const pixels = Number($("#scale-px").value);
    if (!(nm > 0) || !(pixels > 0)) {
      this.setScaleMessage("实际长度和像素长度都必须大于 0。", "warning");
      return;
    }
    if (this.store.getState().measurements.length) {
      const confirmed = await this.dialog.confirm(
        "重新计算全部测量",
        "修改比例尺会从像素原值重新计算当前全部 nm 数据。缺少像素原值的记录会被标记为需要重跑。",
        "重新校准",
      );
      if (!confirmed) return;
    }
    try {
      const result = await this.api.setScale(nm, pixels);
      await this.applySnapshot(result.session, { loadImage: false });
      await this.refresh({ session: false });
      const extra = result.invalidated_measurements
        ? `，${result.invalidated_measurements} 条需重跑`
        : "";
      this.setScaleMessage(
        `校准完成 · ${Number(result.nm_per_pixel).toFixed(6)} nm/px${extra}`,
        result.invalidated_measurements ? "warning" : "success",
      );
      this.viewer.setOverlays({ scaleBox: null });
      this.viewer.setMode("pan");
      this.toast.show("比例尺已保存，所有测量已按像素原值更新。");
      Promise.resolve(this.onScaleApplied(result)).catch((error) => {
        this.toast.show(error.message || "自动启动批处理分析失败。", "error");
      });
    } catch (error) {
      this.setScaleMessage(error.message || "比例尺保存失败。", "error");
      this.toast.show(error.message || "比例尺保存失败。", "error");
    }
  }

  async preprocess() {
    if (this.store.getState().measurements.length) {
      const confirmed = await this.dialog.confirm(
        "应用预处理并清除结果",
        "预处理会生成新的工作图像版本，当前测量与检测框将被清除。",
        "继续预处理",
      );
      if (!confirmed) return;
    }
    const settings = {
      gaussian: Number($("#gaussian-kernel").value),
      clahe_clip: Number($("#clahe-clip").value),
      clahe_grid: Number($("#clahe-grid").value),
    };
    try {
      this.viewer.setMode("pan");
      this.viewer.setOverlays({ scaleBox: null });
      const snapshot = await this.api.preprocess(settings);
      this.store.dispatch({ type: "RESET_IMAGE_STATE" });
      await this.applySnapshot(snapshot, { loadImage: true });
      await this.refresh({ session: false });
      this.toast.show("预处理已应用，当前工作图像版本已更新。");
    } catch (error) {
      this.toast.show(error.message || "预处理失败。", "error");
    }
  }

  async restore() {
    if (this.store.getState().measurements.length) {
      const confirmed = await this.dialog.confirm(
        "恢复原图并清除结果",
        "恢复原图会创建新的工作图像版本，当前测量与检测框将被清除。",
        "恢复原图",
      );
      if (!confirmed) return;
    }
    try {
      this.viewer.setMode("pan");
      this.viewer.setOverlays({ scaleBox: null });
      const snapshot = await this.api.restoreImage();
      this.store.dispatch({ type: "RESET_IMAGE_STATE" });
      await this.applySnapshot(snapshot, { loadImage: true });
      await this.refresh({ session: false });
      this.toast.show("已恢复原始图像。");
    } catch (error) {
      this.toast.show(error.message || "恢复原图失败。", "error");
    }
  }

  async handleSelection(detail) {
    if (detail.type === "measure") {
      const measure = () => this.manualMeasure(detail.p1, detail.p2);
      this.measurementQueue = this.measurementQueue.then(measure, measure);
      return this.measurementQueue;
    }
    if (detail.type === "scale") {
      const pixels = Math.hypot(
        detail.p2[0] - detail.p1[0],
        detail.p2[1] - detail.p1[1],
      );
      $("#scale-px").value = pixels.toFixed(2);
      this.viewer.setOverlays({ scaleBox: null });
      this.setScaleMessage(
        `已从图上取得 ${pixels.toFixed(2)} px，请确认实际长度后保存。`,
      );
      this.updateScaleButton();
      this.viewer.setMode("pan");
      return;
    }
    if (detail.type === "roi") {
      this.setRoi(detail.roi);
      this.viewer.setMode("pan");
    }
  }

  async manualMeasure(p1, p2) {
    const snapshot = this.store.getState().snapshot;
    if (!snapshot?.calibration?.nm_per_pixel) {
      this.toast.show("请先完成比例尺校准。", "warning");
      this.viewer.setMode("pan");
      return;
    }
    try {
      const result = await this.api.manualMeasure(p1, p2);
      await this.applySnapshot(result.session, { loadImage: false });
      await this.refresh({ session: false });
      this.store.dispatch({
        type: "SELECT_MEASUREMENT",
        payload: result.measurement.measurement_id,
      });
      this.toast.show(
        result.measurement.included_in_statistics
          ? "手工测量已记录。"
          : "手工测量已记录，但未通过正式统计 QC。",
        result.measurement.included_in_statistics ? "success" : "warning",
      );
    } catch (error) {
      this.toast.show(error.message || "手工测量失败。", "error");
    }
  }

  setRoi(roi) {
    this.store.dispatch({ type: "UI_PATCH", payload: { roi } });
    this.viewer.setOverlays({ roi });
    $("#roi-status").textContent = roi
      ? `当前：x ${roi[0]} · y ${roi[1]} · ${roi[2]} × ${roi[3]} px`
      : "当前：整张图像";
    $("#viewer-roi").textContent = roi
      ? `分析范围：${roi[2]} × ${roi[3]} px`
      : "分析范围：全图";
  }

  updateScaleButton() {
    const state = this.store.getState();
    const nm = Number($("#scale-nm").value);
    const pixels = Number($("#scale-px").value);
    $("#btn-apply-scale").disabled =
      !state.snapshot?.image || !(nm > 0) || !(pixels > 0) || this.isActive();
    const preview = $("#scale-ratio-preview");
    const ready = nm > 0 && pixels > 0;
    preview.classList.toggle("is-ready", ready);
    preview.textContent = ready
      ? `${nm.toFixed(2)} nm ÷ ${pixels.toFixed(2)} px = ${(nm / pixels).toFixed(6)} nm/px`
      : "等待获取像素长度";
  }

  setScaleMessage(message, kind = "") {
    const element = $("#scale-status");
    element.textContent = message;
    element.classList.remove("is-success", "is-warning", "is-error");
    if (kind) element.classList.add(`is-${kind}`);
  }

  showScaleOverlay(bbox) {
    this.clearScaleOverlay();
    this.viewer.setOverlays({ scaleBox: bbox });
    this.scaleOverlayTimer = window.setTimeout(() => {
      this.viewer.setOverlays({ scaleBox: null });
      this.scaleOverlayTimer = 0;
    }, 5000);
  }

  clearScaleOverlay() {
    if (this.scaleOverlayTimer) window.clearTimeout(this.scaleOverlayTimer);
    this.scaleOverlayTimer = 0;
    this.viewer.setOverlays({ scaleBox: null });
  }

  destroy() {
    if (this.scaleOverlayTimer) window.clearTimeout(this.scaleOverlayTimer);
  }

  setUploadLimit(bytes) {
    const numeric = Number(bytes);
    if (Number.isFinite(numeric) && numeric > 0) this.maxUploadBytes = numeric;
  }

  isActive() {
    const task = this.store.getState().task;
    return Boolean(
      task && ["queued", "running", "cancelling"].includes(task.state),
    );
  }
}
