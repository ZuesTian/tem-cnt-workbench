// @ts-check

import { $ } from "../ui/dom.js";
const ACTIVE = new Set(["queued", "running", "cancelling"]);

export class AnalysisController {
  constructor({
    store,
    api,
    toast,
    applySnapshot,
    refresh,
    onSettled = () => {},
  }) {
    this.store = store;
    this.api = api;
    this.toast = toast;
    this.applySnapshot = applySnapshot;
    this.refresh = refresh;
    this.onSettled = /** @type {(task:any) => unknown} */ (onSettled);
    this.pollTimer = 0;
    this.pollGeneration = 0;

    $("#btn-run-yolo").addEventListener("click", () => this.start());
    $("#btn-cancel-analysis").addEventListener("click", () => this.cancel());
    $("#yolo-conf").addEventListener("input", (event) => {
      $("#conf-label").textContent = (Number(event.target.value) / 100).toFixed(
        2,
      );
    });
    $("#model-path").addEventListener("input", () => {
      this.store.dispatch({ type: "UI_PATCH", payload: { modelDirty: true } });
      $("#model-status").textContent =
        "模型路径已修改，将在下次分析前重新校验并加载。";
    });
  }

  async start() {
    const state = this.store.getState();
    if (!state.snapshot?.image) {
      this.toast.show("请先导入图像。", "warning");
      return;
    }
    if (!state.snapshot?.calibration?.nm_per_pixel) {
      this.toast.show("请先完成比例尺校准。", "warning");
      return;
    }
    if (state.task && ACTIVE.has(state.task.state)) return;
    try {
      $("#model-status").textContent = "正在校验并加载模型…";
      const modelPath = this.api.publicMode
        ? ""
        : $("#model-path").value.trim();
      const model = await this.api.loadModel(modelPath);
      $("#model-status").textContent =
        `${model.reused ? "已复用" : "已加载"}：${model.path} · SHA ${model.sha256.slice(0, 10)}…`;
      this.store.dispatch({ type: "UI_PATCH", payload: { modelDirty: false } });
      const parameters = {
        conf: Number($("#yolo-conf").value) / 100,
        iou_threshold: Number($("#iou-threshold").value),
        roi: state.ui.roi,
        filter_boxes: true,
        tta: this.api.publicMode ? false : $("#enable-tta").checked,
      };
      const task = await this.api.startDetection(parameters);
      this.store.dispatch({ type: "TASK_RECEIVED", payload: task });
      const snapshot = await this.api.getSession();
      await this.applySnapshot(snapshot, { loadImage: false });
      this.toast.show("分析任务已开始。");
      this.resume(task.task_id);
      return task;
    } catch (error) {
      this.toast.show(error.message || "无法启动分析。", "error");
      await this.refresh().catch(() => {});
      return null;
    }
  }

  resume(taskId) {
    this.stopPolling();
    const generation = ++this.pollGeneration;
    const poll = async () => {
      if (generation !== this.pollGeneration) return;
      try {
        const task = await this.api.getTask(taskId);
        this.store.dispatch({ type: "TASK_RECEIVED", payload: task });
        if (ACTIVE.has(task.state)) {
          this.pollTimer = window.setTimeout(poll, 700);
          return;
        }
        this.store.dispatch({ type: "TASK_CLEARED" });
        if (task.state === "completed") {
          this.store.dispatch({
            type: "RUN_RECEIVED",
            payload: task.result || {},
          });
          await this.refresh();
          const stats = task.result?.statistics;
          const kind = stats?.status === "ready" ? "success" : "warning";
          const message =
            stats?.included_count === 0
              ? `分析完成：${task.result?.count || 0} 个检测，0 条通过正式统计 QC。`
              : `分析完成：${task.result?.count || 0} 个检测，${stats?.included_count || 0} 条纳入统计。`;
          this.toast.show(message, kind);
        } else if (task.state === "cancelled") {
          await this.refresh();
          this.toast.show("分析已取消，未写入本次结果。", "warning");
        } else {
          await this.refresh();
          this.toast.show(task.error?.message || "分析失败。", "error");
        }
        await Promise.resolve(this.onSettled(task)).catch((error) => {
          this.toast.show(error.message || "批处理状态更新失败。", "error");
        });
      } catch (error) {
        if (generation !== this.pollGeneration) return;
        this.toast.show(error.message || "读取分析状态失败。", "error");
        this.pollTimer = window.setTimeout(poll, 1600);
      }
    };
    poll();
  }

  async cancel() {
    const task = this.store.getState().task;
    if (!task || !ACTIVE.has(task.state)) return;
    try {
      const updated = await this.api.cancelTask(task.task_id);
      this.store.dispatch({ type: "TASK_RECEIVED", payload: updated });
      this.toast.show("正在停止：当前推理调用结束后将丢弃结果。", "warning");
    } catch (error) {
      this.toast.show(error.message || "取消失败。", "error");
    }
  }

  stopPolling() {
    this.pollGeneration += 1;
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    this.pollTimer = 0;
  }

  destroy() {
    this.stopPolling();
  }
}
