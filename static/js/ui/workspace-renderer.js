// @ts-check

import { $ } from "./dom.js";

const ACTIVE = new Set(["queued", "running", "cancelling"]);

/**
 * Keep DOM projection of server-authoritative state outside application
 * lifecycle wiring, so it can be unit tested independently.
 */
export class WorkspaceRenderer {
  /** @param {{viewer:any, workflow:any}} dependencies */
  constructor({ viewer, workflow }) {
    this.viewer = viewer;
    this.workflow = workflow;
  }

  /** @param {any} state */
  render(state) {
    const snapshot = state.snapshot;
    const image = snapshot?.image;
    const task = state.task;
    const active = Boolean(task && ACTIVE.has(task.state));
    const scaleSet = Boolean(snapshot?.calibration?.nm_per_pixel);
    const hasResults = state.measurements.length > 0;
    const unavailable = active || state.ui.imageLoading;

    this.viewer.setOverlays({
      boxes: state.boxes,
      measurements: state.measurements,
      selectedId: state.selectedMeasurementId,
      roi: state.ui.roi,
      showBoxes: $("#show-boxes").checked,
    });
    this.renderSession({ snapshot, image, task, active, scaleSet, hasResults });
    this.renderTask({ task, active });
    this.renderControls({ image, active, unavailable, scaleSet, hasResults });
    this.renderWorkflow({ image, scaleSet, hasResults });
    this.renderImageMetadata({ snapshot, image, scaleSet, state });

    if (scaleSet)
      this.workflow.setScaleMessage(
        `校准完成 · ${Number(snapshot.calibration.nm_per_pixel).toFixed(6)} nm/px`,
        "success",
      );
    else if (image && !$("#scale-status").classList.contains("is-warning"))
      this.workflow.setScaleMessage("尚未校准");
    this.workflow.updateScaleButton();
  }

  renderSession({ snapshot, image, task, active, scaleSet, hasResults }) {
    const sessionState = $("#session-state");
    sessionState.classList.remove("is-ready", "is-busy", "is-error");
    if (active) {
      sessionState.classList.add("is-busy");
      $("#header-status").textContent =
        task.state === "cancelling"
          ? "正在停止分析…"
          : `正在分析 · ${task.progress || 0}%`;
    } else if (snapshot) {
      sessionState.classList.add("is-ready");
      if (hasResults)
        $("#header-status").textContent =
          `分析结果 · ${snapshot.counts?.included || 0}/${snapshot.counts?.total || 0} 条纳入统计`;
      else if (scaleSet) $("#header-status").textContent = "已校准，等待分析";
      else if (image) $("#header-status").textContent = "图像已载入，等待校准";
      else $("#header-status").textContent = "等待导入图像";
    }
  }

  renderTask({ task, active }) {
    $("#analysis-overlay").hidden = !active;
    $("#analysis-title").textContent =
      task?.state === "cancelling" ? "正在停止分析" : "正在分析图像";
    $("#analysis-detail").textContent =
      task?.state === "cancelling"
        ? "当前推理调用结束后将丢弃本次结果…"
        : `${task?.progress || 0}% · 请保持页面开启，刷新后也可恢复状态`;
    $("#run-label").textContent = active ? "分析进行中…" : "开始自动分析";
    $("#btn-cancel-analysis").hidden = !active;
  }

  renderControls({ image, active, unavailable, scaleSet, hasResults }) {
    const mutationControls = [
      "#btn-open",
      "#btn-open-secondary",
      "#btn-auto-scale",
      "#btn-set-scale",
      "#btn-apply-preprocess",
      "#btn-restore",
      "#btn-roi-mode",
      "#btn-reset-roi",
      "#model-path",
      "#yolo-conf",
      "#iou-threshold",
      "#enable-tta",
    ];
    mutationControls.forEach((selector) => {
      $(selector).disabled =
        unavailable || (!image && !selector.includes("open"));
    });
    $("#btn-run-yolo").disabled = unavailable || !image || !scaleSet;
    $("#btn-apply-scale").disabled =
      unavailable ||
      !image ||
      !(Number($("#scale-nm").value) > 0) ||
      !(Number($("#scale-px").value) > 0);
    ["#btn-pan-mode", "#btn-fit", "#btn-zoom-in", "#btn-zoom-out"].forEach(
      (selector) => {
        $(selector).disabled = !image;
      },
    );
    $("#btn-measure-mode").disabled = unavailable || !image || !scaleSet;

    [
      "#btn-report",
      "#btn-export-csv",
      "#btn-undo",
      "#btn-clear-all",
      "#mobile-report",
      "#mobile-export",
      "#btn-save-image",
      "#mobile-annotated",
    ].forEach((selector) => {
      $(selector).disabled = !hasResults || active;
    });
  }

  renderWorkflow({ image, scaleSet, hasResults }) {
    const completeCount =
      Number(Boolean(image)) + Number(scaleSet) + Number(hasResults);
    $("#workflow-progress").textContent = `${completeCount} / 3`;
    this.setStep(
      "image",
      Boolean(image),
      !image,
      false,
      image ? "已载入" : "当前步骤",
    );
    this.setStep(
      "scale",
      scaleSet,
      Boolean(image) && !scaleSet,
      !image,
      scaleSet ? "已校准" : image ? "当前步骤" : "等待图像",
    );
    this.setStep(
      "analysis",
      hasResults,
      Boolean(image) && scaleSet && !hasResults,
      !scaleSet,
      hasResults ? "已完成" : scaleSet ? "当前步骤" : "等待校准",
    );
  }

  renderImageMetadata({ snapshot, image, scaleSet, state }) {
    $("#image-summary").hidden = !image;
    $("#image-filename").textContent = image?.filename || "—";
    $("#image-dimensions").textContent = image
      ? `${image.width} × ${image.height} px · SHA ${image.sha256.slice(0, 8)}…`
      : "—";
    $("#viewer-file-name").textContent = image?.filename || "尚未载入图像";
    $("#viewer-file-meta").textContent = image
      ? `${image.width} × ${image.height} px${snapshot.preprocessing?.applied ? " · 已预处理" : " · 原始图像"}`
      : "导入图像后即可开始";
    $("#viewer-scale").textContent = scaleSet
      ? `比例尺 ${Number(snapshot.calibration.nm_per_pixel).toFixed(6)} nm/px`
      : "比例尺未校准";
    $("#viewer-run").textContent = snapshot?.latest_run?.run_id
      ? `运行 ${snapshot.latest_run.run_id.slice(0, 8)}`
      : "尚无运行记录";
    if (!state.ui.modelDirty) {
      $("#model-status").textContent = snapshot?.model?.loaded
        ? `已加载：${snapshot.model.path} · SHA ${snapshot.model.sha256.slice(0, 10)}…`
        : "模型将在首次分析时加载。";
    }
  }

  setStep(name, complete, active, locked, label) {
    const step = $(`#step-${name}`);
    step.classList.toggle("is-complete", complete);
    step.classList.toggle("is-active", active);
    step.classList.toggle("is-locked", locked);
    $(`#step-${name}-state`).textContent = label;
  }

  renderViewerMode(mode) {
    const labels = {
      pan: "浏览",
      measure: "手工测量",
      scale: "测量标尺",
      roi: "框选区域",
    };
    $("#canvas-mode-label").textContent = labels[mode] || mode;
    const pan = mode === "pan";
    const measure = mode === "measure";
    const scale = mode === "scale";
    $("#btn-pan-mode").classList.toggle("is-active", pan);
    $("#btn-pan-mode").setAttribute("aria-pressed", String(pan));
    $("#btn-measure-mode").classList.toggle("is-active", measure);
    $("#btn-measure-mode").setAttribute("aria-pressed", String(measure));
    $("#btn-set-scale").classList.toggle("is-active", scale);
    $("#btn-set-scale").setAttribute("aria-pressed", String(scale));
    this.renderViewerInteraction({ mode, pending: false });
  }

  renderViewerInteraction({ mode, pending }) {
    const instruction = $("#canvas-instruction");
    const lineMode = mode === "measure" || mode === "scale";
    instruction.hidden = !lineMode;
    instruction.classList.toggle("is-pending", Boolean(pending));
    if (!lineMode) return;
    $("#canvas-instruction-text").textContent = pending
      ? "第 1 点已确定：点击第 2 点完成，或按 Esc 取消"
      : mode === "measure"
        ? "连续测量：点击两个端点，或按住左键拖线"
        : "比例尺取点：点击标尺两个端点，或按住左键拖线";
  }
}
