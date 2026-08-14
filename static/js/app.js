// @ts-check

import { ApiClient } from "./api/client.js";
import { AnalysisController } from "./features/analysis.js";
import { BatchController } from "./features/batch.js";
import { ResultsController } from "./features/results.js";
import { WorkflowController } from "./features/workflow.js?v=20260814-paste";
import { createStore, initialState } from "./state/store.js";
import { Dialog } from "./ui/dialog.js";
import { $ } from "./ui/dom.js";
import { ToastRegion } from "./ui/toast.js";
import { WorkspaceRenderer } from "./ui/workspace-renderer.js";
import { ImageViewer } from "./viewer/image-viewer.js";

const api = new ApiClient();
const store = createStore(initialState);
const toast = new ToastRegion($("#toast-region"), $("#app-live-region"));
const dialog = new Dialog($("#modal-overlay"), $("#app-shell"));
let workflow;
let analysis;
let batch;
let workspaceRenderer;
let loadedRevision = null;
let refreshGeneration = 0;

const viewer = new ImageViewer($("#main-canvas"), $("#canvas-container"), {
  onMode: (mode) => workspaceRenderer?.renderViewerMode(mode),
  onZoom: (zoom) => {
    $("#zoom-label").textContent = `${Math.round(zoom * 100)}%`;
  },
  onCoordinate: (point) => {
    $("#coord-label").textContent = point
      ? `x ${Math.round(point.x)} · y ${Math.round(point.y)}`
      : "x — · y —";
  },
  onSelection: (detail) => workflow?.handleSelection(detail),
  onInteractionState: (detail) =>
    workspaceRenderer?.renderViewerInteraction(detail),
  onError: (message) => toast.show(message, "error"),
});

async function applySnapshot(snapshot, options = {}) {
  store.dispatch({ type: "SESSION_RECEIVED", payload: snapshot });
  const image = snapshot.image;
  if (!image) {
    loadedRevision = null;
    viewer.clear();
    $("#canvas-placeholder").classList.remove("hidden");
    return;
  }
  const shouldLoad =
    options.loadImage || loadedRevision !== image.revision || !viewer.image;
  if (shouldLoad) {
    store.dispatch({ type: "UI_PATCH", payload: { imageLoading: true } });
    try {
      viewer.setOverlays({ scaleBox: null });
      const blob = await api.getImageBlob(image.content_url);
      const objectUrl = URL.createObjectURL(blob);
      try {
        await viewer.load(objectUrl);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      loadedRevision = image.revision;
      $("#canvas-placeholder").classList.add("hidden");
    } finally {
      store.dispatch({ type: "UI_PATCH", payload: { imageLoading: false } });
    }
  }
  if (snapshot.calibration?.nm)
    $("#scale-nm").value = String(snapshot.calibration.nm);
  if (snapshot.calibration?.pixels)
    $("#scale-px").value = String(snapshot.calibration.pixels);
  else if (shouldLoad) $("#scale-px").value = "";
  workflow?.updateScaleButton();
  if (snapshot.preprocessing?.applied) {
    if (snapshot.preprocessing.gaussian)
      $("#gaussian-kernel").value = String(snapshot.preprocessing.gaussian);
    if (snapshot.preprocessing.clahe_clip)
      $("#clahe-clip").value = String(snapshot.preprocessing.clahe_clip);
    if (snapshot.preprocessing.clahe_grid)
      $("#clahe-grid").value = String(snapshot.preprocessing.clahe_grid);
  }
  if (snapshot.model?.loaded && !store.getState().ui.modelDirty) {
    $("#model-path").value = snapshot.model.path || $("#model-path").value;
  }
}

async function refresh(options = {}) {
  const generation = ++refreshGeneration;
  const includeSession = options.session !== false;
  const requests = [api.getMeasurements(), api.getStatistics()];
  if (includeSession) requests.unshift(api.getSession());
  const responses = await Promise.all(requests);
  if (generation !== refreshGeneration) return;
  let snapshot = store.getState().snapshot;
  let measurements;
  let statistics;
  if (includeSession) {
    [snapshot, measurements, statistics] = responses;
    await applySnapshot(snapshot, { loadImage: false });
  } else {
    [measurements, statistics] = responses;
  }
  store.dispatch({
    type: "MEASUREMENTS_RECEIVED",
    payload: measurements.items || [],
  });
  store.dispatch({ type: "STATISTICS_RECEIVED", payload: statistics });
  const latestRunId = snapshot?.latest_run?.run_id;
  if (latestRunId) {
    try {
      const run = await api.getRun(latestRunId);
      if (generation === refreshGeneration)
        store.dispatch({ type: "RUN_RECEIVED", payload: run });
    } catch {
      // The session remains usable if an expired run cannot be restored.
    }
  } else {
    store.dispatch({
      type: "RUN_RECEIVED",
      payload: { boxes: [], class_names: {} },
    });
  }
}

const results = new ResultsController({
  store,
  api,
  viewer,
  dialog,
  toast,
  refresh,
});
workflow = new WorkflowController({
  store,
  api,
  viewer,
  dialog,
  toast,
  applySnapshot,
  refresh,
  onScaleApplied: (result) => batch?.onScaleApplied(result),
});
analysis = new AnalysisController({
  store,
  api,
  toast,
  applySnapshot,
  refresh,
  onSettled: (task) => batch?.onAnalysisSettled(task),
});
batch = new BatchController({
  store,
  api,
  workflow,
  analysis,
  toast,
  dialog,
  applySnapshot,
  refresh,
});
workspaceRenderer = new WorkspaceRenderer({ viewer, workflow });

store.subscribe((state) => {
  workspaceRenderer.render(state);
  results.render(state);
});

function applyConfig(config) {
  const publicMode = config.public_mode === true;
  const batchEnabled =
    config.features?.batch_queue === true &&
    config.features?.editable_checkpoints === true;
  api.publicMode = publicMode;
  document.body.classList.toggle("is-public-mode", publicMode);
  $("#model-path").readOnly = publicMode;
  $("#model-path").disabled = publicMode;
  $("#model-path-label").textContent = publicMode ? "服务器模型" : "模型路径";
  $("#enable-tta").disabled = publicMode;
  $("#btn-open-folder").disabled = !batchEnabled;
  $("#btn-open-folder").title = batchEnabled
    ? "选择当前文件夹中的 TEM 图像（最多 50 张）"
    : "当前后端版本尚未启用可编辑批处理";
  if (publicMode) $("#enable-tta").checked = false;
  workflow?.setUploadLimit(config.limits?.max_upload_bytes);
  if (config.yolo) {
    const confidence = Math.round(
      Number(config.yolo.confidence_threshold || 0.25) * 100,
    );
    $("#yolo-conf").value = String(confidence);
    $("#conf-label").textContent = (confidence / 100).toFixed(2);
    $("#iou-threshold").value = String(config.yolo.iou_threshold || 0.45);
    $("#model-path").value = config.yolo.default_model || "best.onnx";
    if (publicMode) {
      $("#model-status").textContent =
        `服务器固定模型 · ${config.yolo.backend || "onnxruntime"}`;
    }
  }
  if (config.image_processing) {
    $("#gaussian-kernel").value = String(
      config.image_processing.gaussian_kernel || 5,
    );
    $("#clahe-clip").value = String(config.image_processing.clahe_clip || 2);
    $("#clahe-grid").value = String(config.image_processing.clahe_grid || 8);
  }
  if (config.measurement) {
    $("#scale-nm").value = String(config.measurement.default_scale_nm || 20);
    // Pixel length must come from this image's detected or manually drawn scale bar.
    $("#scale-px").value = "";
  }
  workflow?.updateScaleButton();
}

function setupShellInteractions() {
  const openResults = () => {
    document.body.classList.add("results-open");
    $("#btn-results-drawer").setAttribute("aria-expanded", "true");
  };
  const closeResults = () => {
    document.body.classList.remove("results-open");
    $("#btn-results-drawer").setAttribute("aria-expanded", "false");
  };
  $("#btn-results-drawer").addEventListener("click", () =>
    document.body.classList.contains("results-open")
      ? closeResults()
      : openResults(),
  );
  $("#btn-close-results").addEventListener("click", closeResults);
  $("#mobile-results").addEventListener("click", () =>
    $("#results-panel").scrollIntoView({ behavior: "smooth", block: "start" }),
  );

  document.addEventListener("keydown", (event) => {
    const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(
      document.activeElement?.tagName,
    );
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
      event.preventDefault();
      workflow.openFilePicker();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (!$("#btn-undo").disabled) $("#btn-undo").click();
      return;
    }
    if (event.key === "Escape" && $("#modal-overlay").hidden) {
      if (document.body.classList.contains("results-open")) closeResults();
      else viewer.setMode("pan");
      return;
    }
    if (editing) return;
    if (event.key.toLowerCase() === "m" && !$("#btn-measure-mode").disabled)
      viewer.setMode("measure");
    if (event.key.toLowerCase() === "v") viewer.setMode("pan");
    if (event.key === "+" || event.key === "=") viewer.zoomBy(1.2);
    if (event.key === "-") viewer.zoomBy(1 / 1.2);
    if (event.key === "0") viewer.fitToWindow();
  });
}

async function initialize() {
  setupShellInteractions();
  workspaceRenderer.render(store.getState());
  results.render(store.getState());
  try {
    const snapshot = await api.getSession();
    const config = await api.getConfig();
    applyConfig(config);
    await applySnapshot(snapshot, { loadImage: true });
    await refresh({ session: false });
    await batch.initialize();
    const activeTask = store.getState().snapshot?.active_task;
    if (activeTask) {
      store.dispatch({ type: "TASK_RECEIVED", payload: activeTask });
      analysis.resume(activeTask.task_id);
      toast.show("已恢复正在运行的分析任务。", "warning");
    }
  } catch (error) {
    $("#session-state").classList.add("is-error");
    $("#header-status").textContent = "无法连接分析服务";
    toast.show(error.message || "应用初始化失败。", "error");
  }
}

window.addEventListener(
  "beforeunload",
  () => {
    analysis.destroy();
    batch.destroy();
    results.destroy();
    workflow.destroy();
    viewer.destroy();
  },
  { once: true },
);

initialize();
