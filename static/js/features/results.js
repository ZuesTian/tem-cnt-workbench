// @ts-check

import { setupTabs } from "../ui/tabs.js";
import { $ } from "../ui/dom.js";
import {
  buildHistogram,
  formatBinNumber,
} from "./histogram.js";

function niceAxisMaximum(value) {
  if (!(value > 0)) return 1;
  if (value <= 5) return Math.ceil(value);
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const factor = [1, 2, 2.5, 5, 10].find((candidate) => candidate >= fraction);
  return (factor || 10) * exponent;
}

function histogramMethodLabel(method) {
  const labels = {
    "Freedman–Diaconis": "Freedman–Diaconis 稳健自动分箱",
    Sturges: "Sturges 自动分箱（四分位距为 0 时回退）",
    "manual-count": "手动指定区间数",
    "manual-width": "手动指定区间宽度",
    "single-value": "单一数值区间",
  };
  return labels[method] || "自动分箱";
}

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
    this.histogram = null;
    this.histogramGeometry = [];
    this.activeBinIndex = -1;
    this.manualBinCount = 10;
    this.manualBinWidth = 0.2;

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

    ["#chart-scope", "#chart-y-axis"].forEach((selector) => {
      $(selector).addEventListener("change", () => {
        this.activeBinIndex = -1;
        this.hideChartTooltip();
        this.requestHistogram();
      });
    });
    $("#chart-bin-mode").addEventListener("change", () => {
      this.updateBinControl();
      this.activeBinIndex = -1;
      this.hideChartTooltip();
      this.requestHistogram();
    });
    $("#chart-bin-value").addEventListener("input", (event) => {
      const mode = $("#chart-bin-mode").value;
      const value = Number(event.target.value);
      if (mode === "count" && value > 0) this.manualBinCount = value;
      if (mode === "width" && value > 0) this.manualBinWidth = value;
      this.activeBinIndex = -1;
      this.hideChartTooltip();
      this.requestHistogram();
    });
    this.chart.addEventListener("pointermove", (event) =>
      this.onChartPointerMove(event),
    );
    this.chart.addEventListener("pointerleave", () => {
      this.activeBinIndex = -1;
      this.hideChartTooltip();
      this.requestHistogram();
    });
    this.chart.addEventListener("keydown", (event) =>
      this.onChartKeydown(event),
    );
    this.updateBinControl();

    this.chartObserver = new ResizeObserver(() => this.requestHistogram());
    this.chartObserver.observe(this.chart);
  }

  render(state) {
    this.renderMetrics(state);
    this.renderGuidance(state);
    this.renderTable(state);
    this.renderHistogramScope(state);
    this.requestHistogram();
  }

  renderHistogramScope(state) {
    const measurements = state.batch?.measurements || [];
    const includedCount = measurements.filter(
      (measurement) => measurement.included_in_statistics === true,
    ).length;
    const option = $("#chart-scope-batch");
    option.disabled = includedCount === 0;
    option.textContent = includedCount
      ? `整批文件夹 (${includedCount})`
      : "整批文件夹";
    if (option.disabled && $("#chart-scope").value === "batch") {
      $("#chart-scope").value = "current";
    }
  }

  renderMetrics(state) {
    const stats = state.statistics || {};
    const diameter = stats.diameter || {};
    $("#stat-count").textContent = String(stats.included_count || 0);
    $("#stat-mean").textContent = this.metric(diameter.mean);
    $("#stat-std").textContent = this.metric(
      diameter.sample_std ?? diameter.std,
    );
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
        [
          "样本标准差 (n−1)",
          `${this.metric(stats.diameter?.sample_std ?? stats.diameter?.std)} nm`,
        ],
        ["管径中位数", `${this.metric(stats.diameter?.median)} nm`],
        [
          "四分位范围 (Q1–Q3)",
          `${this.metric(stats.diameter?.q1)}–${this.metric(stats.diameter?.q3)} nm`,
        ],
        ["四分位距 (IQR)", `${this.metric(stats.diameter?.iqr)} nm`],
        ["变异系数", `${this.metric(stats.diameter?.cv_percent)}%`],
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

  updateBinControl() {
    const mode = $("#chart-bin-mode").value;
    const field = $("#chart-bin-value-field");
    const input = $("#chart-bin-value");
    field.hidden = mode === "auto";
    if (mode === "count") {
      $("#chart-bin-value-label").textContent = "区间数";
      $("#chart-bin-value-unit").textContent = "档";
      input.min = "1";
      input.max = "30";
      input.step = "1";
      input.value = String(this.manualBinCount);
    } else if (mode === "width") {
      $("#chart-bin-value-label").textContent = "区间宽度";
      $("#chart-bin-value-unit").textContent = "nm";
      input.min = "0.001";
      input.removeAttribute("max");
      input.step = "0.01";
      input.value = String(this.manualBinWidth);
    }
  }

  histogramValues(state) {
    const scope = $("#chart-scope").value;
    const measurements =
      scope === "batch"
        ? state.batch?.measurements || []
        : state.measurements;
    return measurements
      .filter((measurement) => measurement.included_in_statistics === true)
      .map((measurement) => Number(measurement.diameter_nm));
  }

  renderHistogram() {
    if ($("#results-view-chart").hidden) return;
    const state = this.store.getState();
    const mode = $("#chart-bin-mode").value;
    const histogram = buildHistogram(this.histogramValues(state), {
      mode,
      binCount: this.manualBinCount,
      binWidth: this.manualBinWidth,
      minBins: 5,
      maxBins: 20,
    });
    this.histogram = histogram;
    this.renderHistogramSummary(histogram);
    this.renderBinTable(histogram);
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
    const borderStrong = styles
      .getPropertyValue("--color-border-strong")
      .trim();
    const accent = styles.getPropertyValue("--color-accent").trim();
    const accentStrong = styles
      .getPropertyValue("--color-accent-strong")
      .trim();
    const text = styles.getPropertyValue("--color-text").trim();
    this.histogramGeometry = [];
    if (!histogram.values.length) {
      context.fillStyle = muted;
      context.font = "12px sans-serif";
      context.textAlign = "center";
      context.fillText(
        "暂无通过 QC 的 nm 数据",
        rect.width / 2,
        rect.height / 2,
      );
      $("#chart-range").textContent = "暂无数据";
      $("#chart-sample-size").textContent = "N = 0";
      $("#chart-caption").textContent = "通过正式统计 QC 后显示直径分布。";
      this.chart.setAttribute(
        "aria-label",
        "CNT 管径分布直方图，暂无通过 QC 的数据",
      );
      this.hideChartTooltip();
      return;
    }
    const yAxis = $("#chart-y-axis").value;
    const yValues = histogram.bins.map((bin) =>
      yAxis === "percent" ? bin.percent : bin.count,
    );
    const padding = { top: 30, right: 10, bottom: 42, left: 42 };
    const plotWidth = rect.width - padding.left - padding.right;
    const plotHeight = rect.height - padding.top - padding.bottom;
    const axisMaximum = niceAxisMaximum(Math.max(...yValues, 1));
    const tickCount =
      yAxis === "count" ? Math.max(1, Math.min(4, axisMaximum)) : 4;
    context.font = "12px sans-serif";
    context.textBaseline = "middle";
    for (let tick = 0; tick <= tickCount; tick += 1) {
      const y = padding.top + plotHeight - (plotHeight * tick) / tickCount;
      context.strokeStyle = border;
      context.beginPath();
      context.moveTo(padding.left, y + 0.5);
      context.lineTo(padding.left + plotWidth, y + 0.5);
      context.stroke();
      context.fillStyle = muted;
      context.textAlign = "right";
      const value = (axisMaximum * tick) / tickCount;
      const label =
        yAxis === "percent" ? `${Math.round(value)}%` : String(Math.round(value));
      context.fillText(label, padding.left - 7, y);
    }
    const slot = plotWidth / histogram.bins.length;
    histogram.bins.forEach((bin, index) => {
      const barHeight = (yValues[index] / axisMaximum) * plotHeight;
      const x = padding.left + index * slot + 2;
      const y = padding.top + plotHeight - barHeight;
      const width = Math.max(2, slot - 4);
      const active = index === this.activeBinIndex;
      context.fillStyle = active ? accentStrong : accent;
      context.fillRect(x, y, width, barHeight);
      context.strokeStyle = active ? accentStrong : borderStrong;
      context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, barHeight - 1));
      this.histogramGeometry.push({ index, x, y, width, height: barHeight });
      if (slot >= 27 && bin.count > 0) {
        context.fillStyle = text;
        context.font = "600 10px sans-serif";
        context.textAlign = "center";
        context.textBaseline = "bottom";
        const label =
          yAxis === "percent"
            ? `${bin.percent.toFixed(bin.percent < 10 ? 1 : 0)}%`
            : String(bin.count);
        context.fillText(label, x + width / 2, Math.max(12, y - 4));
      }
    });

    context.strokeStyle = borderStrong;
    context.beginPath();
    context.moveTo(padding.left + 0.5, padding.top);
    context.lineTo(padding.left + 0.5, padding.top + plotHeight + 0.5);
    context.lineTo(padding.left + plotWidth, padding.top + plotHeight + 0.5);
    context.stroke();

    context.fillStyle = muted;
    context.textBaseline = "top";
    context.font = "11px sans-serif";
    const maxLabels = Math.max(2, Math.floor(plotWidth / 52));
    const every = Math.max(1, Math.ceil(histogram.bins.length / maxLabels));
    for (let index = 0; index <= histogram.bins.length; index += 1) {
      if (index !== 0 && index !== histogram.bins.length && index % every) continue;
      const value = histogram.lower + index * histogram.binWidth;
      const x = padding.left + (index / histogram.bins.length) * plotWidth;
      context.textAlign =
        index === 0 ? "left" : index === histogram.bins.length ? "right" : "center";
      context.fillText(
        formatBinNumber(value, histogram.binWidth),
        x,
        padding.top + plotHeight + 9,
      );
    }
    context.textAlign = "center";
    context.fillText(
      "管径 (nm)",
      padding.left + plotWidth / 2,
      padding.top + plotHeight + 26,
    );

    this.chart.setAttribute(
      "aria-label",
      `CNT 管径分布直方图，${histogram.values.length} 根，${histogram.bins.length} 个区间；可用左右方向键查看各区间。`,
    );
    if (this.activeBinIndex >= 0) this.showChartTooltip(this.activeBinIndex);
  }

  renderHistogramSummary(histogram) {
    const summary = histogram.summary;
    const scope = $("#chart-scope").value;
    const scopeLabel = scope === "batch" ? "整批文件夹" : "当前图片";
    $("#chart-sample-size").textContent = `N = ${summary.count}`;
    if (!summary.count) {
      $("#chart-summary").hidden = true;
      return;
    }
    $("#chart-summary").hidden = false;
    $("#chart-median").textContent = `${this.metric(summary.median)} nm`;
    $("#chart-quartiles").textContent =
      `${this.metric(summary.q1)}–${this.metric(summary.q3)} nm`;
    $("#chart-sample-std").textContent = `${this.metric(summary.sampleStd)} nm`;
    $("#chart-cv").textContent = `${this.metric(summary.cvPercent)}%`;
    $("#chart-range").textContent =
      `${this.metric(summary.min)}–${this.metric(summary.max)} nm`;
    const width = formatBinNumber(histogram.binWidth, histogram.binWidth);
    const notes = [
      `${scopeLabel}共 ${summary.count} 根 CNT，归入 ${histogram.bins.length} 个连续区间`,
      `${histogramMethodLabel(histogram.method)}，区间宽度 ${width} nm`,
    ];
    if (summary.count < 5) notes.push("样本少于 5 根，分布形状仅供参考");
    if (histogram.adjusted) notes.push("输入参数会产生过多区间，已限制为最多 20 档");
    $("#chart-caption").textContent = `${notes.join("；")}。`;
  }

  renderBinTable(histogram) {
    const tbody = $("#chart-bin-tbody");
    tbody.replaceChildren();
    if (!histogram.bins.length) {
      const row = document.createElement("tr");
      row.className = "empty-row";
      const cell = document.createElement("td");
      cell.colSpan = 3;
      cell.textContent = "暂无统计数据";
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    const fragment = document.createDocumentFragment();
    histogram.bins.forEach((bin) => {
      const row = document.createElement("tr");
      row.dataset.binIndex = String(bin.index);
      row.classList.toggle("is-active", bin.index === this.activeBinIndex);
      const interval = document.createElement("td");
      interval.textContent = `${bin.interval} nm`;
      const count = document.createElement("td");
      count.textContent = String(bin.count);
      const percent = document.createElement("td");
      percent.textContent = `${bin.percent.toFixed(1)}%`;
      row.append(interval, count, percent);
      fragment.appendChild(row);
    });
    tbody.appendChild(fragment);
  }

  onChartPointerMove(event) {
    if (!this.histogram?.bins.length) return;
    const rect = this.chart.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const geometry = this.histogramGeometry.find(
      (bar) =>
        x >= bar.x &&
        x <= bar.x + bar.width &&
        y >= bar.y &&
        y <= bar.y + Math.max(bar.height, 8),
    );
    const index = geometry?.index ?? -1;
    if (index === this.activeBinIndex) return;
    this.activeBinIndex = index;
    if (index < 0) this.hideChartTooltip();
    this.requestHistogram();
  }

  onChartKeydown(event) {
    if (!this.histogram?.bins.length) return;
    let index = this.activeBinIndex;
    if (event.key === "ArrowRight") index = Math.min(this.histogram.bins.length - 1, index + 1);
    else if (event.key === "ArrowLeft") index = Math.max(0, index < 0 ? 0 : index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = this.histogram.bins.length - 1;
    else if (event.key === "Escape") index = -1;
    else return;
    event.preventDefault();
    this.activeBinIndex = index;
    if (index < 0) this.hideChartTooltip();
    this.requestHistogram();
  }

  showChartTooltip(index) {
    const bin = this.histogram?.bins[index];
    const geometry = this.histogramGeometry[index];
    if (!bin || !geometry) return;
    const tooltip = $("#chart-tooltip");
    const strong = document.createElement("strong");
    strong.textContent = `${bin.interval} nm`;
    const detail = document.createElement("span");
    detail.textContent = `${bin.count} 根 · ${bin.percent.toFixed(1)}%`;
    tooltip.replaceChildren(strong, detail);
    const rect = this.chart.getBoundingClientRect();
    tooltip.style.left = `${Math.min(rect.width - 72, Math.max(72, geometry.x + geometry.width / 2))}px`;
    tooltip.style.top = `${Math.max(48, geometry.y - 2)}px`;
    tooltip.hidden = false;
  }

  hideChartTooltip() {
    $("#chart-tooltip").hidden = true;
    $("#chart-bin-tbody")
      .querySelectorAll("tr.is-active")
      .forEach((row) => row.classList.remove("is-active"));
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
