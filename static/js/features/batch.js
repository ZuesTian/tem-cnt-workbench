// @ts-check

import { $ } from "../ui/dom.js";
import { BatchStorage } from "./batch-storage.js";

const IMAGE_PATTERN = /\.(tif|tiff|jpe?g|png|bmp)$/i;
const MAX_BATCH_IMAGES = 50;
const EMPTY_MEASUREMENT_CSV =
  "\uFEFF序号,导出ID,测量ID,运行ID,图像文件,图像SHA256,图像版本,模型路径,模型SHA256,检测置信度,IoU阈值,ROI,预处理,比例尺nm,比例尺pixels,nm_per_pixel,直径(nm),管壁厚度(nm),直径(pixels),起点X,起点Y,终点X,终点Y,来源,方法,纳入统计,QC状态,QC原因,QC版本\r\n";
const STATUS_LABELS = {
  pending: "待处理",
  loading: "载入中",
  scale: "待校准",
  analyzing: "分析中",
  review: "待确认",
  saved: "已保存",
  error: "失败",
};

const collator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

/** @param {string} value */
function safeName(value) {
  return String(value || "batch")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, 80) || "batch";
}

/** @param {string} filename */
function fileStem(filename) {
  const position = filename.lastIndexOf(".");
  return safeName(position > 0 ? filename.slice(0, position) : filename);
}

/** @param {Date} date */
function timestamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}` +
    `_${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`
  );
}

/**
 * Keep only images directly inside the selected directory. Browser directory
 * inputs expose paths as "folder/file.ext"; deeper paths are intentionally
 * excluded to match the current-folder-only workflow.
 * @param {File[]} inputFiles
 * @param {number} [limit]
 */
export function selectCurrentFolderImages(inputFiles, limit = MAX_BATCH_IMAGES) {
  let nestedSkipped = 0;
  let folderName = "selected-images";
  const files = inputFiles.filter((file) => {
    if (!IMAGE_PATTERN.test(file.name)) return false;
    const relative = file.webkitRelativePath || file.name;
    const parts = relative.split("/").filter(Boolean);
    if (parts.length > 1) folderName = parts[0];
    if (parts.length > 2) {
      nestedSkipped += 1;
      return false;
    }
    return true;
  });
  files.sort((left, right) =>
    collator.compare(left.webkitRelativePath || left.name, right.webkitRelativePath || right.name),
  );
  if (!files.length) throw new Error("所选文件夹当前层没有可处理的 TEM 图像。");
  if (files.length > limit) {
    throw new Error(`当前层有 ${files.length} 张图像；单批最多 ${limit} 张，请拆分后重试。`);
  }
  return { folderName, files, nestedSkipped };
}

/** @param {unknown} value */
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** @param {number | null | undefined} value */
function metric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(6) : "";
}

/** @param {Array<any>} items */
export function buildBatchSummaryCsv(items) {
  const headings = [
    "index",
    "filename",
    "status",
    "total_count",
    "included_count",
    "excluded_count",
    "mean_nm",
    "median_nm",
    "sample_std_nm",
    "q1_nm",
    "q3_nm",
    "min_nm",
    "max_nm",
  ];
  const rows = items.map((item, index) => {
    const statistics = item.checkpoint?.statistics || {};
    const diameter = statistics.diameter || {};
    return [
      index + 1,
      item.name,
      item.status,
      statistics.total_count ?? "",
      statistics.included_count ?? "",
      statistics.excluded_count ?? "",
      metric(diameter.mean),
      metric(diameter.median),
      metric(diameter.sample_std ?? diameter.std),
      metric(diameter.q1),
      metric(diameter.q3),
      metric(diameter.min),
      metric(diameter.max),
    ];
  });
  return `\uFEFF${[headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** @param {Array<any>} items */
function aggregateMeasurements(items) {
  return items.flatMap((item) =>
    (item.checkpoint?.measurements || []).map((measurement) => ({
      ...measurement,
      batch_item_id: item.id,
      batch_filename: item.name,
    })),
  );
}

export class BatchController {
  constructor({
    store,
    api,
    workflow,
    analysis,
    toast,
    dialog,
    applySnapshot,
    refresh,
    storage = new BatchStorage(),
  }) {
    this.store = store;
    this.api = api;
    this.workflow = workflow;
    this.analysis = analysis;
    this.toast = toast;
    this.dialog = dialog;
    this.applySnapshot = applySnapshot;
    this.refresh = refresh;
    this.storage = storage;
    this.items = [];
    this.currentIndex = -1;
    this.folderName = "";
    this.batchId = "";
    this.outputName = "";
    this.outputDirectory = null;
    this.busy = false;
    this.statusMessage = "等待载入队列";
    this.persistTimer = 0;
    this.folderInput = $("#folder-input");

    $("#btn-open-folder").addEventListener("click", () => this.openFolderPicker());
    this.folderInput.addEventListener("change", () => {
      const files = [...(this.folderInput.files || [])];
      this.folderInput.value = "";
      if (files.length) this.start(files);
    });
    $("#btn-batch-output").addEventListener("click", () =>
      this.chooseOutputDirectory(),
    );
    $("#btn-batch-prev").addEventListener("click", () =>
      this.navigate(this.currentIndex - 1),
    );
    $("#btn-batch-next").addEventListener("click", () =>
      this.navigate(this.currentIndex + 1),
    );
    $("#btn-batch-confirm").addEventListener("click", () => this.confirmCurrent());
    $("#btn-batch-summary").addEventListener("click", () => this.exportSummary(true));
    $("#btn-batch-clear").addEventListener("click", () => this.clear());
    $("#batch-queue").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-index]");
      if (button) this.navigate(Number(button.dataset.index));
    });
    document.addEventListener("keydown", (event) => this.onKeydown(event));
  }

  openFolderPicker() {
    if (this.workflow.isActive()) {
      this.toast.show("分析进行中，请先取消或等待完成。", "warning");
      return;
    }
    this.folderInput.click();
  }

  async start(files) {
    let selected;
    try {
      selected = selectCurrentFolderImages(files);
    } catch (error) {
      this.toast.show(error.message || "无法读取所选文件夹。", "warning");
      return;
    }
    if (this.items.length) {
      const confirmed = await this.dialog.confirm(
        "替换当前批处理",
        "当前队列会结束；已经写入输出目录或浏览器缓存的结果不会删除。",
        "载入新文件夹",
      );
      if (!confirmed) return;
    }
    this.batchId = globalThis.crypto?.randomUUID?.() || `batch-${Date.now()}`;
    this.folderName = selected.folderName;
    this.outputName = `TEM_CNT_${safeName(this.folderName)}_${timestamp()}`;
    this.outputDirectory = null;
    $("#batch-output-status").textContent =
      "未授权目录；结果将安全缓存于此浏览器。";
    $("#btn-batch-output").textContent = "选择自动保存目录";
    this.items = selected.files.map((file, index) => ({
      id: `${this.batchId}-${String(index + 1).padStart(3, "0")}`,
      name: file.name,
      path: file.webkitRelativePath || file.name,
      file,
      status: "pending",
      saved: false,
      checkpoint: null,
      error: "",
    }));
    this.currentIndex = -1;
    this.statusMessage = selected.nestedSkipped
      ? `已忽略子文件夹中的 ${selected.nestedSkipped} 张图像；可点击队列中的任意图片切换。`
      : "队列已建立；可点击任意图片切换，并自动识别其标尺像素长度。";
    this.publish();
    this.schedulePersist();
    await this.loadIndex(0, { capture: false });
  }

  async initialize() {
    try {
      const record = await this.storage.loadBatch();
      if (!record?.items?.length) return;
      const restorable = record.items.every((item) => item.file instanceof Blob);
      if (!restorable) {
        await this.storage.clearBatch();
        return;
      }
      this.batchId = record.batchId;
      this.folderName = record.folderName;
      this.outputName = record.outputName;
      this.items = record.items.map((item) => ({
        ...item,
        status: ["loading", "analyzing"].includes(item.status)
          ? item.checkpoint
            ? "review"
            : "pending"
          : item.status,
      }));
      this.currentIndex = Math.min(
        Math.max(0, Number(record.currentIndex) || 0),
        this.items.length - 1,
      );
      this.statusMessage = "已从浏览器缓存恢复上次批处理队列。";
      if (this.workflow.isActive()) {
        this.items[this.currentIndex].status = "analyzing";
        this.statusMessage = "已恢复队列，继续等待当前分析任务完成。";
        this.publish();
        return;
      }
      this.publish();
      await this.loadIndex(this.currentIndex, { capture: false });
    } catch {
      // A disabled or quota-limited IndexedDB must not block normal analysis.
    }
  }

  async loadIndex(index, { capture = true } = {}) {
    if (this.busy || index < 0 || index >= this.items.length) return;
    if (this.workflow.isActive()) {
      this.toast.show("分析进行中，请等待完成后切换图像。", "warning");
      return;
    }
    const current = this.items[this.currentIndex];
    if (
      capture &&
      current &&
      ["review", "saved"].includes(current.status)
    ) {
      await this.captureCheckpoint(current).catch(() => {});
      if (current.saved) await this.saveArtifacts(current).catch(() => {});
    }
    this.busy = true;
    this.currentIndex = index;
    const item = this.items[index];
    const restoredStatus = item.saved ? "saved" : "review";
    item.status = "loading";
    item.error = "";
    this.statusMessage = `正在载入 ${item.name}…`;
    this.publish();
    try {
      const snapshot = await this.workflow.upload(item.file);
      if (!snapshot) throw new Error("图像载入失败");
      if (item.checkpoint) {
        const restored = await this.api.restoreCheckpoint(item.checkpoint);
        await this.applySnapshot(restored.session, { loadImage: false });
        await this.refresh({ session: false });
        item.status = restoredStatus;
        this.statusMessage = `${item.name} 的检查点已恢复，可继续编辑。`;
      } else {
        item.status = "scale";
        this.statusMessage = "已自动检测标尺像素长度；请核对并确认实际 nm。";
        this.publish();
        await this.workflow.autoScale();
      }
    } catch (error) {
      item.status = "error";
      item.error = error.message || "载入失败";
      this.statusMessage = `${item.name}：${item.error}`;
      this.toast.show(this.statusMessage, "error");
    } finally {
      this.busy = false;
      this.publish();
      this.schedulePersist();
    }
  }

  async navigate(index) {
    if (index < 0 || index >= this.items.length || index === this.currentIndex) return;
    await this.loadIndex(index);
  }

  async onScaleApplied() {
    const item = this.items[this.currentIndex];
    if (!item || item.checkpoint || item.status !== "scale" || this.busy) return;
    item.status = "analyzing";
    this.statusMessage = "比例尺已确认，正在自动分析；完成后停留供复核。";
    this.publish();
    this.schedulePersist();
    const task = await this.analysis.start();
    if (!task) {
      item.status = "error";
      item.error = "无法启动自动分析";
      this.statusMessage = item.error;
      this.publish();
    }
  }

  async onAnalysisSettled(task) {
    const item = this.items[this.currentIndex];
    if (!item || item.status !== "analyzing") return;
    if (task.state !== "completed") {
      item.status = "error";
      item.error = task.error?.message || (task.state === "cancelled" ? "分析已取消" : "分析失败");
      this.statusMessage = item.error;
      this.publish();
      this.schedulePersist();
      return;
    }
    try {
      await this.captureCheckpoint(item);
      item.status = "review";
      this.statusMessage = "分析完成并已建立检查点；请复核，确认后进入下一张。";
      this.publish();
      this.schedulePersist();
      await this.saveArtifacts(item);
      this.statusMessage = this.outputDirectory
        ? "草稿结果已自动写入输出目录；确认时会覆盖为复核后的版本。"
        : "草稿结果已自动保存到浏览器缓存；确认时会更新。";
    } catch (error) {
      item.status = "review";
      this.statusMessage = `分析完成，但自动保存失败：${error.message || "未知错误"}`;
      this.toast.show(this.statusMessage, "warning");
    }
    this.publish();
  }

  async captureCheckpoint(item) {
    const checkpoint = await this.api.getCheckpoint();
    item.checkpoint = checkpoint;
    return checkpoint;
  }

  async confirmCurrent() {
    const item = this.items[this.currentIndex];
    if (!item || this.busy || this.workflow.isActive()) return;
    if (!this.store.getState().measurements.length && !item.checkpoint) {
      this.toast.show("当前没有可确认的测量结果。", "warning");
      return;
    }
    this.busy = true;
    this.statusMessage = "正在保存复核后的 CSV、JSON 与标注图…";
    this.publish();
    try {
      await this.captureCheckpoint(item);
      await this.saveArtifacts(item);
      item.saved = true;
      item.status = "saved";
      item.savedAt = new Date().toISOString();
      this.statusMessage = `${item.name} 已确认并保存。`;
      this.publish();
      this.schedulePersist();
      let next = this.items.findIndex(
        (candidate, index) =>
          index > this.currentIndex &&
          !candidate.saved &&
          candidate.status !== "error",
      );
      if (next < 0) {
        next = this.items.findIndex(
          (candidate, index) =>
            index !== this.currentIndex &&
            !candidate.saved &&
            candidate.status !== "error",
        );
      }
      if (next >= 0) {
        this.busy = false;
        await this.loadIndex(next, { capture: false });
        return;
      }
      await this.exportSummary(true);
      const savedCount = this.items.filter((candidate) => candidate.saved).length;
      const failedCount = this.items.filter(
        (candidate) => candidate.status === "error",
      ).length;
      if (failedCount) {
        this.statusMessage =
          `批处理已结束：成功保存 ${savedCount} 张，失败 ${failedCount} 张；` +
          "请根据汇总中的错误信息检查失败项。";
        this.toast.show(this.statusMessage, "warning");
      } else {
        this.statusMessage = `整批 ${savedCount} 张图像均已确认并保存。`;
        this.toast.show(this.statusMessage, "success");
      }
    } catch (error) {
      this.statusMessage = error.message || "保存当前结果失败。";
      this.toast.show(this.statusMessage, "error");
    } finally {
      this.busy = false;
      this.publish();
      this.schedulePersist();
    }
  }

  artifactNames(item) {
    const index = this.items.indexOf(item) + 1;
    const prefix = `${String(index).padStart(3, "0")}_${fileStem(item.name)}`;
    return {
      csv: `${prefix}_measurements.csv`,
      checkpoint: `${prefix}_checkpoint.json`,
      annotated: `${prefix}_annotated.png`,
    };
  }

  async saveArtifacts(item) {
    if (!item.checkpoint) await this.captureCheckpoint(item);
    const names = this.artifactNames(item);
    const latestRunId = this.store.getState().snapshot?.latest_run?.run_id;
    const hasMeasurements = item.checkpoint.measurements.length > 0;
    let csvBlob;
    let annotatedBlob;
    if (hasMeasurements) {
      const [csv, annotated] = await Promise.all([
        this.api.requestBlob(this.api.exportUrl()),
        this.api.requestBlob(this.api.annotatedUrl(latestRunId)),
      ]);
      csvBlob = csv.blob;
      annotatedBlob = annotated.blob;
    } else {
      csvBlob = new Blob([EMPTY_MEASUREMENT_CSV], {
        type: "text/csv;charset=utf-8",
      });
      annotatedBlob = await this.api.getImageBlob(
        this.store.getState().snapshot.image.content_url,
      );
    }
    const checkpoint = new Blob(
      [JSON.stringify(item.checkpoint, null, 2)],
      { type: "application/json;charset=utf-8" },
    );
    await Promise.all([
      this.writeArtifact(names.csv, csvBlob),
      this.writeArtifact(names.checkpoint, checkpoint),
      this.writeArtifact(names.annotated, annotatedBlob),
    ]);
  }

  async writeArtifact(filename, blob) {
    if (this.outputDirectory) {
      try {
        const handle = await this.outputDirectory.getFileHandle(filename, {
          create: true,
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        this.outputDirectory = null;
        $("#batch-output-status").textContent =
          "输出目录权限已失效；后续结果改存浏览器缓存。";
        this.toast.show(error.message || "输出目录写入失败，已切换到浏览器缓存。", "warning");
      }
    }
    await this.storage.putArtifact(this.batchId, filename, blob);
  }

  async chooseOutputDirectory() {
    const picker = /** @type {any} */ (window).showDirectoryPicker;
    if (typeof picker !== "function") {
      this.toast.show("当前浏览器不支持目录写入，结果会保存在浏览器缓存。", "warning");
      return;
    }
    try {
      const parent = await picker.call(window, { mode: "readwrite" });
      this.outputDirectory = await parent.getDirectoryHandle(this.outputName, {
        create: true,
      });
      $("#batch-output-status").textContent = `自动保存到 ${this.outputName}`;
      $("#btn-batch-output").textContent = "更换自动保存目录";
      const cached = await this.storage.listArtifacts(this.batchId);
      for (const artifact of cached) {
        const handle = await this.outputDirectory.getFileHandle(artifact.filename, {
          create: true,
        });
        const writable = await handle.createWritable();
        await writable.write(artifact.blob);
        await writable.close();
      }
      this.toast.show(
        cached.length
          ? `输出目录已授权，并迁移 ${cached.length} 个缓存文件。`
          : "输出目录已授权，后续结果将自动保存。",
      );
    } catch (error) {
      if (error?.name !== "AbortError") {
        this.toast.show(error.message || "无法授权输出目录。", "warning");
      }
    }
  }

  async exportSummary(downloadFallback) {
    const completed = this.items.filter((item) => item.checkpoint);
    if (!completed.length) {
      this.toast.show("还没有可汇总的图像结果。", "warning");
      return;
    }
    const summary = new Blob([buildBatchSummaryCsv(this.items)], {
      type: "text/csv;charset=utf-8",
    });
    const queueState = new Blob(
      [
        JSON.stringify(
          {
            schema_version: "web-batch-summary-v1",
            batch_id: this.batchId,
            folder_name: this.folderName,
            generated_at: new Date().toISOString(),
            items: this.items.map((item, index) => ({
              index: index + 1,
              filename: item.name,
              status: item.status,
              saved: item.saved,
              statistics: item.checkpoint?.statistics || null,
            })),
          },
          null,
          2,
        ),
      ],
      { type: "application/json;charset=utf-8" },
    );
    await this.writeArtifact("summary.csv", summary);
    await this.writeArtifact("queue-state.json", queueState);
    if (!this.outputDirectory && downloadFallback) this.downloadBlob(summary, `${this.outputName}_summary.csv`);
    if (downloadFallback) this.toast.show("整批统计汇总已生成。", "success");
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  publish() {
    const active = this.items.length > 0;
    const saved = this.items.filter((item) => item.saved).length;
    const withResults = this.items.filter((item) => item.checkpoint).length;
    this.store.dispatch({
      type: "BATCH_RECEIVED",
      payload: {
        active,
        batchId: this.batchId,
        folderName: this.folderName,
        currentIndex: this.currentIndex,
        items: this.items.map((item) => ({
          id: item.id,
          name: item.name,
          path: item.path,
          status: item.status,
          saved: item.saved,
          error: item.error,
          includedCount: item.checkpoint?.statistics?.included_count || 0,
        })),
        measurements: aggregateMeasurements(this.items),
      },
    });
    const panel = $("#batch-panel");
    panel.hidden = !active;
    if (!active) return;
    $("#batch-name").textContent = this.folderName;
    $("#batch-position").textContent = `${this.currentIndex + 1} / ${this.items.length}`;
    $("#batch-completed").textContent = `已保存 ${saved} 张`;
    const progress = $("#batch-progress");
    progress.setAttribute("aria-valuemax", String(this.items.length));
    progress.setAttribute("aria-valuenow", String(saved));
    $("#batch-progress-bar").style.width = `${(saved / this.items.length) * 100}%`;
    const queue = $("#batch-queue");
    queue.replaceChildren();
    const fragment = document.createDocumentFragment();
    this.items.forEach((item, index) => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.index = String(index);
      button.dataset.status = item.status;
      button.classList.toggle("is-current", index === this.currentIndex);
      button.setAttribute("aria-current", index === this.currentIndex ? "step" : "false");
      button.disabled = this.busy || this.workflow.isActive();
      const position = document.createElement("span");
      position.textContent = String(index + 1).padStart(2, "0");
      const name = document.createElement("span");
      name.className = "batch-file-name";
      name.textContent = item.name;
      name.title = item.path;
      const status = document.createElement("small");
      status.textContent = STATUS_LABELS[item.status] || item.status;
      button.append(position, name, status);
      row.appendChild(button);
      fragment.appendChild(row);
    });
    queue.appendChild(fragment);
    $("#btn-batch-prev").disabled = this.busy || this.currentIndex <= 0;
    $("#btn-batch-next").disabled =
      this.busy ||
      this.workflow.isActive() ||
      this.currentIndex >= this.items.length - 1;
    $("#btn-batch-confirm").disabled =
      this.busy ||
      this.workflow.isActive() ||
      !["review", "saved"].includes(this.items[this.currentIndex]?.status);
    $("#btn-batch-confirm").textContent =
      this.currentIndex === this.items.length - 1
        ? "确认并保存，完成整批"
        : "确认并保存，进入下一张";
    $("#btn-batch-summary").disabled = this.busy || withResults === 0;
    $("#batch-status").textContent = this.statusMessage;
  }

  schedulePersist() {
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = 0;
      this.storage
        .saveBatch({
          id: "active",
          schemaVersion: 1,
          batchId: this.batchId,
          folderName: this.folderName,
          outputName: this.outputName,
          currentIndex: this.currentIndex,
          items: this.items,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {
          $("#batch-output-status").textContent =
            "浏览器空间不足：队列仅在当前页面保留，请尽快授权输出目录。";
        });
    }, 250);
  }

  async clear() {
    if (!this.items.length) return;
    if (this.busy || this.workflow.isActive()) {
      this.toast.show("当前图像仍在载入、分析或保存，请结束后再清除队列。", "warning");
      return;
    }
    const confirmed = await this.dialog.confirm(
      "结束当前批处理",
      "队列会从界面移除；已写入目录或缓存的结果不会删除。",
      "结束批处理",
    );
    if (!confirmed) return;
    this.items = [];
    this.currentIndex = -1;
    this.folderName = "";
    this.batchId = "";
    this.outputDirectory = null;
    this.statusMessage = "等待载入队列";
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
    this.persistTimer = 0;
    await this.storage.clearBatch().catch(() => {});
    this.publish();
  }

  onKeydown(event) {
    if (!this.items.length || event.defaultPrevented) return;
    const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(
      document.activeElement?.tagName,
    );
    if (editing) return;
    if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      this.navigate(this.currentIndex - 1);
    } else if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      this.navigate(this.currentIndex + 1);
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      this.confirmCurrent();
    }
  }

  destroy() {
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
  }
}
