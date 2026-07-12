// @ts-check

import { setupTabs } from "../ui/tabs.js";
import { $ } from "../ui/dom.js";

export function resultGuidance(statistics, scaleSet) {
  const total = Number(statistics?.total_count || 0);
  const included = Number(statistics?.included_count || 0);
  const excluded = Number(statistics?.excluded_count || 0);
  if (!total) {
    return {
      kind: "empty",
      mark: "01",
      title: "还没有分析结果",
      detail: "完成左侧三步流程后，结果会出现在这里。",
    };
  }
  if (!scaleSet) {
    return {
      kind: "warning",
      mark: "!",
      title: "结果缺少比例尺",
      detail: "请先完成校准，再用于正式报告或论文。",
    };
  }
  if (included === total) {
    return {
      kind: "success",
      mark: "✓",
      title: `${total} 条记录均通过正式统计 QC`,
      detail: "可以继续导出报告、CSV 与原始分辨率标注图。",
    };
  }
  return {
    kind: "warning",
    mark: "!",
    title:
      included === 0
        ? `${total} 条记录，0 条纳入统计`
        : `${included} 条纳入统计，${excluded} 条需复核`,
    detail:
      included === 0
        ? "当前结果不能作为正式 nm 统计，请检查比例尺与 QC 原因。"
        : "橙色记录未进入统计，导出文件中会保留其原因。",
  };
}

export class ResultsController {
  constructor({ store, api, viewer, dialog, toast, refresh }) {
    this.store = store;
    this.api = api;
    this.viewer = viewer;
    this.dialog = dialog;
    this.toast = toast;
    this.refresh = refresh;
    this.tableBody = $("#results-tbody");
    this.chart = $("#chart-canvas");
    this.chartFrame = 0;

    setupTabs($(".results-tabs"), (panelId) => {
      if (panelId === "results-view-chart") this.requestHistogram();
    });
    $("#btn-sort-diameter").addEventListener("click", () => this.toggleSort());
    $("#page-size").addEventListener("change", (event) => {
      this.store.dispatch({
        type: "UI_PATCH",
        payload: { pageSize: Number(event.target.value), page: 1 },
      });
    });
    $("#btn-page-prev").addEventListener("click", () => this.changePage(-1));
    $("#btn-page-next").addEventListener("click", () => this.changePage(1));
    this.tableBody.addEventListener("click", (event) =>
      this.onTableClick(event),
    );
    $("#btn-report").addEventListener("click", () => this.showReport());
    $("#btn-export-csv").addEventListener("click", () => this.downloadCsv());
    $("#btn-save-image").addEventListener("click", () =>
      this.downloadAnnotated(),
    );
    $("#btn-undo").addEventListener("click", () => this.undo());
    $("#btn-clear-all").addEventListener("click", () => this.clear());
    $("#mobile-report").addEventListener("click", () => this.showReport());
    $("#mobile-export").addEventListener("click", () => this.downloadCsv());
    $("#mobile-annotated").addEventListener("click", () =>
      this.downloadAnnotated(),
    );

    this.chartObserver = new ResizeObserver(() => this.requestHistogram());
    this.chartObserver.observe(this.chart);
  }

  render(state) {
    this.renderMetrics(state);
    this.renderGuidance(state);
    this.renderTable(state);
    this.requestHistogram();
  }

  renderMetrics(state) {
    const stats = state.statistics || {};
    const diameter = stats.diameter || {};
    $("#stat-count").textContent = String(stats.included_count || 0);
    $("#stat-mean").textContent = this.metric(diameter.mean);
    $("#stat-std").textContent = this.metric(diameter.std);
    $("#result-count-badge").textContent = `${state.measurements.length} 条`;
  }

  renderGuidance(state) {
    const element = $("#result-guidance");
    const scaleSet = Boolean(state.snapshot?.calibration?.nm_per_pixel);
    const guidance = resultGuidance(state.statistics, scaleSet);
    element.classList.remove("is-success", "is-warning", "is-error");
    const mark = document.createElement("span");
    mark.className = "guidance-mark";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("p");
    const strong = document.createElement("strong");
    const detail = document.createTextNode("");

    if (guidance.kind !== "empty") element.classList.add(`is-${guidance.kind}`);
    mark.textContent = guidance.mark;
    strong.textContent = guidance.title;
    detail.textContent = guidance.detail;
    copy.append(strong, document.createElement("br"), detail);
    element.replaceChildren(mark, copy);
  }

  renderTable(state) {
    const descending = state.ui.sortDescending;
    const sorted = [...state.measurements].sort((left, right) => {
      const a = Number(left.diameter_nm || 0);
      const b = Number(right.diameter_nm || 0);
      return descending ? b - a : a - b;
    });
    const totalPages = Math.max(
      1,
      Math.ceil(sorted.length / state.ui.pageSize),
    );
    const page = Math.min(Math.max(1, state.ui.page), totalPages);
    if (page !== state.ui.page) {
      queueMicrotask(() =>
        this.store.dispatch({ type: "UI_PATCH", payload: { page } }),
      );
    }
    const start = (page - 1) * state.ui.pageSize;
    const rows = sorted.slice(start, start + state.ui.pageSize);
    this.tableBody.replaceChildren();
    if (!rows.length) {
      const row = document.createElement("tr");
      row.className = "empty-row";
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.textContent = "暂无测量记录";
      row.appendChild(cell);
      this.tableBody.appendChild(row);
    } else {
      const fragment = document.createDocumentFragment();
      rows.forEach((measurement, offset) =>
        fragment.appendChild(
          this.createRow(measurement, start + offset, state),
        ),
      );
      this.tableBody.appendChild(fragment);
    }
    $("#page-summary").textContent =
      `${rows.length ? start + 1 : 0}–${start + rows.length} / ${sorted.length}`;
    $("#btn-page-prev").disabled = page <= 1;
    $("#btn-page-next").disabled = page >= totalPages;
    $("#page-size").value = String(state.ui.pageSize);
    const sortHeader = $("#diameter-sort-header");
    sortHeader.setAttribute(
      "aria-sort",
      descending ? "descending" : "ascending",
    );
    $("#btn-sort-diameter").querySelector("[aria-hidden]").textContent =
      descending ? "↓" : "↑";
  }

  createRow(measurement, position, state) {
    const row = document.createElement("tr");
    row.dataset.measurementId = measurement.measurement_id;
    row.classList.toggle(
      "is-selected",
      measurement.measurement_id === state.selectedMeasurementId,
    );
    const number = document.createElement("td");
    number.textContent = String(measurement.index || position + 1);
    const diameter = document.createElement("td");
    diameter.textContent = this.metric(measurement.diameter_nm);
    const method = document.createElement("td");
    const methodLabel = document.createElement("span");
    methodLabel.className = "method-label";
    methodLabel.title = measurement.source_method || measurement.method || "";
    methodLabel.textContent = this.methodName(measurement);
    method.appendChild(methodLabel);
    const qc = document.createElement("td");
    const qcPill = document.createElement("span");
    const included = measurement.included_in_statistics === true;
    qcPill.className = `qc-pill${included ? " is-included" : ""}`;
    qcPill.textContent = included ? "纳入" : "复核";
    qcPill.title = included
      ? "通过正式统计 QC"
      : measurement.reject_reason || "未通过正式统计 QC";
    qc.appendChild(qcPill);
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-row";
    remove.dataset.deleteId = measurement.measurement_id;
    remove.setAttribute(
      "aria-label",
      `删除第 ${measurement.index || position + 1} 条测量`,
    );
    remove.textContent = "×";
    actions.appendChild(remove);
    row.append(number, diameter, method, qc, actions);
    return row;
  }

  async onTableClick(event) {
    const remove = event.target.closest("[data-delete-id]");
    if (remove) {
      event.stopPropagation();
      await this.deleteMeasurement(remove.dataset.deleteId);
      return;
    }
    const row = event.target.closest("tr[data-measurement-id]");
    if (!row) return;
    this.store.dispatch({
      type: "SELECT_MEASUREMENT",
      payload: row.dataset.measurementId,
    });
  }

  toggleSort() {
    const state = this.store.getState();
    this.store.dispatch({
      type: "UI_PATCH",
      payload: { sortDescending: !state.ui.sortDescending, page: 1 },
    });
  }

  changePage(delta) {
    const state = this.store.getState();
    const pages = Math.max(
      1,
      Math.ceil(state.measurements.length / state.ui.pageSize),
    );
    const page = Math.min(pages, Math.max(1, state.ui.page + delta));
    this.store.dispatch({ type: "UI_PATCH", payload: { page } });
  }

  async deleteMeasurement(id) {
    try {
      await this.api.deleteMeasurement(id);
      if (this.store.getState().selectedMeasurementId === id) {
        this.store.dispatch({ type: "SELECT_MEASUREMENT", payload: null });
      }
      await this.refresh();
      this.toast.show("测量记录已删除。");
    } catch (error) {
      this.toast.show(error.message || "删除失败。", "error");
    }
  }

  async undo() {
    const measurements = this.store.getState().measurements;
    const last = measurements[measurements.length - 1];
    if (last) await this.deleteMeasurement(last.measurement_id);
  }

  async clear() {
    if (!this.store.getState().measurements.length) return;
    const confirmed = await this.dialog.confirm(
      "清空测量结果",
      "将删除当前图像的全部自动与手工测量。原始图像不会被删除。",
      "清空结果",
    );
    if (!confirmed) return;
    try {
      await this.api.clearMeasurements();
      this.store.dispatch({ type: "SELECT_MEASUREMENT", payload: null });
      await this.refresh();
      this.toast.show("测量结果已清空。");
    } catch (error) {
      this.toast.show(error.message || "清空失败。", "error");
    }
  }

  downloadCsv() {
    if (!this.store.getState().measurements.length) {
      this.toast.show("当前没有可导出的测量记录。", "warning");
      return;
    }
    this.download(this.api.exportUrl());
  }

  downloadAnnotated() {
    const snapshot = this.store.getState().snapshot;
    if (!snapshot?.image || !this.store.getState().measurements.length) {
      this.toast.show("当前没有可保存的标注结果。", "warning");
      return;
    }
    this.download(this.api.annotatedUrl(snapshot.latest_run?.run_id));
  }

  async download(url) {
    try {
      await this.api.download(url);
    } catch (error) {
      this.toast.show(error.message || "下载失败。", "error");
    }
  }

  async showReport() {
    const state = this.store.getState();
    if (!state.measurements.length) return;
    try {
      const manifest = await this.api.getExportContext();
      const snapshot = state.snapshot;
      const stats = manifest.statistics || state.statistics;
      const fragment = document.createDocumentFragment();
      const grid = document.createElement("div");
      grid.className = "report-grid";
      const cards = [
        ["结果集 ID", manifest.export_id || "—"],
        ["图像", manifest.image?.filename || snapshot?.image?.filename || "—"],
        [
          "比例尺",
          manifest.calibration?.nm_per_pixel
            ? `${Number(manifest.calibration.nm_per_pixel).toFixed(6)} nm/px`
            : "未校准",
        ],
        [
          "结果范围",
          `${manifest.scope?.measurement_count || 0} 条记录 · ${manifest.scope?.contributing_run_ids?.length || 0} 个运行`,
        ],
      ];
      cards.forEach(([label, value]) => {
        const card = document.createElement("article");
        const name = document.createElement("span");
        name.textContent = label;
        const content = document.createElement("strong");
        content.textContent = value;
        card.append(name, content);
        grid.appendChild(card);
      });
      fragment.appendChild(grid);

      const table = document.createElement("table");
      table.className = "report-table";
      const tbody = document.createElement("tbody");
      [
        ["测量记录总数", stats.total_count],
        ["纳入正式统计", stats.included_count],
        ["复核/排除", stats.excluded_count],
        ["平均管径", `${this.metric(stats.diameter?.mean)} nm`],
        ["管径标准差", `${this.metric(stats.diameter?.std)} nm`],
        ["管径中位数", `${this.metric(stats.diameter?.median)} nm`],
        [
          "管径范围",
          `${this.metric(stats.diameter?.min)}–${this.metric(stats.diameter?.max)} nm`,
        ],
      ].forEach(([label, value]) => {
        const row = document.createElement("tr");
        const key = document.createElement("th");
        key.scope = "row";
        key.textContent = String(label);
        const content = document.createElement("td");
        content.textContent = String(value ?? "—");
        row.append(key, content);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      fragment.appendChild(table);

      const actions = document.createElement("div");
      actions.className = "report-export-actions";
      const reportButton = document.createElement("button");
      reportButton.type = "button";
      reportButton.className = "button button-secondary";
      reportButton.textContent = "下载 HTML 报告";
      reportButton.addEventListener("click", () =>
        this.download(this.api.reportUrl()),
      );
      const manifestButton = document.createElement("button");
      manifestButton.type = "button";
      manifestButton.className = "button button-secondary";
      manifestButton.textContent = "下载清单 JSON";
      manifestButton.addEventListener("click", () =>
        this.download(this.api.manifestUrl()),
      );
      actions.append(reportButton, manifestButton);
      fragment.appendChild(actions);

      const pre = document.createElement("pre");
      pre.className = "manifest-block";
      pre.textContent = JSON.stringify(manifest, null, 2);
      fragment.appendChild(pre);
      this.dialog.open("可复现分析报告", fragment, { okLabel: "完成" });
    } catch (error) {
      this.toast.show(error.message || "生成报告失败。", "error");
    }
  }

  requestHistogram() {
    if (this.chartFrame) return;
    this.chartFrame = window.requestAnimationFrame(() => {
      this.chartFrame = 0;
      this.renderHistogram();
    });
  }

  renderHistogram() {
    if ($("#results-view-chart").hidden) return;
    const values = this.store
      .getState()
      .measurements.filter(
        (measurement) => measurement.included_in_statistics === true,
      )
      .map((measurement) => Number(measurement.diameter_nm))
      .filter((value) => Number.isFinite(value) && value > 0);
    const rect = this.chart.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (this.chart.width !== width || this.chart.height !== height) {
      this.chart.width = width;
      this.chart.height = height;
    }
    const context = this.chart.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const styles = getComputedStyle(document.documentElement);
    const muted = styles.getPropertyValue("--color-text-muted").trim();
    const border = styles.getPropertyValue("--color-border").trim();
    const accent = styles.getPropertyValue("--color-accent").trim();
    if (!values.length) {
      context.fillStyle = muted;
      context.font = "12px sans-serif";
      context.textAlign = "center";
      context.fillText(
        "暂无通过 QC 的 nm 数据",
        rect.width / 2,
        rect.height / 2,
      );
      $("#chart-range").textContent = "暂无数据";
      $("#chart-caption").textContent = "通过正式统计 QC 后显示直径分布。";
      return;
    }
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min = Math.max(0, min - 0.5);
      max += 0.5;
    }
    const bins = Math.min(16, Math.max(5, Math.ceil(Math.sqrt(values.length))));
    const counts = new Array(bins).fill(0);
    const binWidth = (max - min) / bins;
    values.forEach((value) => {
      counts[Math.min(bins - 1, Math.floor((value - min) / binWidth))] += 1;
    });
    const padding = { top: 14, right: 10, bottom: 32, left: 34 };
    const plotWidth = rect.width - padding.left - padding.right;
    const plotHeight = rect.height - padding.top - padding.bottom;
    const maxCount = Math.max(...counts, 1);
    context.font = "12px sans-serif";
    context.textBaseline = "middle";
    for (let tick = 0; tick <= 3; tick += 1) {
      const y = padding.top + plotHeight - (plotHeight * tick) / 3;
      context.strokeStyle = border;
      context.beginPath();
      context.moveTo(padding.left, y + 0.5);
      context.lineTo(padding.left + plotWidth, y + 0.5);
      context.stroke();
      context.fillStyle = muted;
      context.textAlign = "right";
      context.fillText(
        String(Math.round((maxCount * tick) / 3)),
        padding.left - 6,
        y,
      );
    }
    counts.forEach((count, index) => {
      const slot = plotWidth / bins;
      const barHeight = (count / maxCount) * plotHeight;
      context.fillStyle = accent;
      context.fillRect(
        padding.left + index * slot + 2,
        padding.top + plotHeight - barHeight,
        Math.max(2, slot - 4),
        barHeight,
      );
    });
    context.fillStyle = muted;
    context.textBaseline = "top";
    context.textAlign = "left";
    context.fillText(
      min.toFixed(1),
      padding.left,
      padding.top + plotHeight + 9,
    );
    context.textAlign = "right";
    context.fillText(
      max.toFixed(1),
      padding.left + plotWidth,
      padding.top + plotHeight + 9,
    );
    $("#chart-range").textContent = `${min.toFixed(1)}–${max.toFixed(1)} nm`;
    $("#chart-caption").textContent =
      `${values.length} 条纳入统计的测量，${bins} 个区间。`;
  }

  methodName(measurement) {
    if (measurement.source === "manual") return "手工";
    const method = measurement.source_method || measurement.method || "自动";
    return method.replaceAll("_", " ");
  }

  metric(value) {
    if (value === null || value === undefined || value === "") return "—";
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : "—";
  }

  destroy() {
    this.chartObserver.disconnect();
    if (this.chartFrame) window.cancelAnimationFrame(this.chartFrame);
  }
}
