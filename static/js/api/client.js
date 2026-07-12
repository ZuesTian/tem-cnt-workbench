// @ts-check

/** @typedef {{code:string, message:string, details:Record<string, unknown>}} ApiErrorPayload */

export const SESSION_HEADER = "X-TEM-CNT-Session";
const SESSION_STORAGE_KEY = "tem-cnt-analysis-session";
const PUBLIC_API_BASE = "https://tem-cnt.47.236.76.214.nip.io";

export function resolveApiBase(location = window.location) {
  const configured = window.TEM_CNT_API_BASE;
  if (typeof configured === "string") return configured.replace(/\/$/, "");
  return location.hostname === "zuestian.github.io" ? PUBLIC_API_BASE : "";
}

function readStoredSession(storage = window.sessionStorage) {
  try {
    return storage.getItem(SESSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeSession(value, storage = window.sessionStorage) {
  if (!value) return;
  try {
    storage.setItem(SESSION_STORAGE_KEY, value);
  } catch {
    // Private browsing can disable sessionStorage; the response header still works.
  }
}

function filenameFromResponse(response) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1] || "tem-cnt-result.bin";
}

export class ApiError extends Error {
  /** @param {ApiErrorPayload} payload @param {number} status */
  constructor(payload, status) {
    super(payload.message || `请求失败 (${status})`);
    this.name = "ApiError";
    this.code = payload.code || "REQUEST_FAILED";
    this.status = status;
    this.details = payload.details || {};
  }
}

export class ApiClient {
  /** @param {{baseUrl?:string, storage?:Storage}} [options] */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? resolveApiBase()).replace(/\/$/, "");
    this.storage = options.storage || window.sessionStorage;
    this.sessionId = readStoredSession(this.storage);
    this.publicMode = Boolean(this.baseUrl);
  }

  /** @param {string} path */
  endpoint(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path}`;
  }

  /** @param {Response} response */
  rememberSession(response) {
    const value = response.headers.get(SESSION_HEADER);
    if (value) {
      this.sessionId = value;
      storeSession(value, this.storage);
    }
  }

  /** @param {RequestInit & {timeout?:number}} options */
  makeHeaders(options) {
    const headers = new Headers(options.headers || {});
    if (this.sessionId && !headers.has(SESSION_HEADER))
      headers.set(SESSION_HEADER, this.sessionId);
    if (
      options.body &&
      !(options.body instanceof FormData) &&
      !headers.has("Content-Type")
    ) {
      headers.set("Content-Type", "application/json");
    }
    return headers;
  }

  /** @param {string} path @param {RequestInit & {timeout?:number}} [options] */
  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      options.timeout ?? 30000,
    );
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort();
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
    try {
      const response = await fetch(this.endpoint(path), {
        ...options,
        headers: this.makeHeaders(options),
        credentials: this.baseUrl ? "omit" : "same-origin",
        signal: controller.signal,
      });
      this.rememberSession(response);
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : null;
      if (!response.ok) {
        const error = payload?.error || {
          code: `HTTP_${response.status}`,
          message: response.statusText || "请求失败",
          details: {},
        };
        throw new ApiError(error, response.status);
      }
      if (!payload || !Object.hasOwn(payload, "data")) {
        throw new ApiError(
          {
            code: "INVALID_RESPONSE",
            message: "服务返回了无法识别的数据",
            details: {},
          },
          500,
        );
      }
      return payload.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError(
          {
            code: "REQUEST_TIMEOUT",
            message: "请求超时，请稍后重试",
            details: {},
          },
          408,
        );
      }
      throw new ApiError(
        { code: "NETWORK_ERROR", message: "无法连接分析服务", details: {} },
        0,
      );
    } finally {
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  }

  /** @param {string} path @param {RequestInit & {timeout?:number}} [options] */
  async requestBlob(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      options.timeout ?? 60000,
    );
    try {
      const response = await fetch(this.endpoint(path), {
        ...options,
        headers: this.makeHeaders(options),
        credentials: this.baseUrl ? "omit" : "same-origin",
        signal: controller.signal,
      });
      this.rememberSession(response);
      if (!response.ok) {
        let payload = null;
        if ((response.headers.get("content-type") || "").includes("json"))
          payload = await response.json();
        throw new ApiError(
          payload?.error || {
            code: `HTTP_${response.status}`,
            message: response.statusText || "请求失败",
            details: {},
          },
          response.status,
        );
      }
      return {
        blob: await response.blob(),
        filename: filenameFromResponse(response),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError(
          {
            code: "REQUEST_TIMEOUT",
            message: "下载请求超时，请稍后重试",
            details: {},
          },
          408,
        );
      }
      throw new ApiError(
        { code: "NETWORK_ERROR", message: "无法连接分析服务", details: {} },
        0,
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async download(path) {
    const result = await this.requestBlob(path);
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async getImageBlob(path) {
    return (await this.requestBlob(path, { timeout: 60000 })).blob;
  }

  getSession() {
    return this.request("/api/session");
  }
  getConfig() {
    return this.request("/api/config");
  }
  getHealth() {
    return this.request("/api/health");
  }
  getStatus() {
    return this.request("/api/status");
  }
  getScaleStatus() {
    return this.request("/api/scale/status");
  }
  getStatistics() {
    return this.request("/api/data/statistics");
  }
  getMeasurements() {
    return this.request("/api/data/measurements");
  }
  getRun(runId) {
    return this.request(`/api/runs/${encodeURIComponent(runId)}`);
  }

  /** @param {File} file */
  uploadImage(file) {
    const body = new FormData();
    body.append("file", file);
    return this.request("/api/image/upload", {
      method: "POST",
      body,
      timeout: 60000,
    });
  }

  preprocess(settings) {
    return this.request("/api/process/preprocess", {
      method: "POST",
      body: JSON.stringify(settings),
      timeout: 60000,
    });
  }

  restoreImage() {
    return this.request("/api/process/restore", { method: "POST" });
  }
  detectScale() {
    return this.request("/api/scale/detect", { method: "POST", body: "{}" });
  }
  setScale(nm, pixels) {
    return this.request("/api/scale/set", {
      method: "POST",
      body: JSON.stringify({ nm, pixels }),
    });
  }

  loadModel(modelPath = "") {
    return this.request("/api/yolo/load", {
      method: "POST",
      body: JSON.stringify(modelPath ? { model_path: modelPath } : {}),
      timeout: 180000,
    });
  }

  startDetection(parameters) {
    return this.request("/api/yolo/detect", {
      method: "POST",
      body: JSON.stringify(parameters),
    });
  }
  getTask(taskId) {
    return this.request(`/api/yolo/status/${encodeURIComponent(taskId)}`, {
      timeout: 15000,
    });
  }
  cancelTask(taskId) {
    return this.request(`/api/yolo/cancel/${encodeURIComponent(taskId)}`, {
      method: "POST",
    });
  }
  manualMeasure(p1, p2) {
    return this.request("/api/measure/manual", {
      method: "POST",
      body: JSON.stringify({ p1, p2 }),
      timeout: 60000,
    });
  }
  deleteMeasurement(measurementId) {
    return this.request(
      `/api/data/measurements/${encodeURIComponent(measurementId)}`,
      { method: "DELETE" },
    );
  }
  clearMeasurements() {
    return this.request("/api/data/measurements", { method: "DELETE" });
  }

  exportUrl() {
    return "/api/data/export";
  }
  getExportContext() {
    return this.request("/api/data/export-context");
  }
  manifestUrl() {
    return "/api/data/manifest";
  }
  reportUrl() {
    return "/api/data/report";
  }
  annotatedUrl(runId) {
    const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
    return `/api/data/annotated-image${query}`;
  }
}
