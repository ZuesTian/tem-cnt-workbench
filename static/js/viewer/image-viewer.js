// @ts-check

const MODES = new Set(["pan", "measure", "scale", "roi"]);
const LINE_MODES = new Set(["measure", "scale"]);
const DRAG_THRESHOLD_PX = 5;

export class ImageViewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} container
   * @param {{onMode?:(mode:string)=>void,onZoom?:(zoom:number)=>void,onCoordinate?:(point:{x:number,y:number}|null)=>void,onSelection?:(detail:{type:string,p1?:number[],p2?:number[],roi?:number[]})=>void,onInteractionState?:(detail:{mode:string,pending:boolean,point?:number[]})=>void,onError?:(message:string)=>void}} callbacks
   */
  constructor(canvas, container, callbacks = {}) {
    this.canvas = canvas;
    this.container = container;
    this.context = canvas.getContext("2d", { alpha: false });
    this.callbacks = callbacks;
    this.image = null;
    this.imageWidth = 0;
    this.imageHeight = 0;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.mode = "pan";
    this.pointerId = null;
    this.lastPointer = null;
    this.pointerOrigin = null;
    this.selectionStart = null;
    this.selectionCurrent = null;
    this.lineAnchor = null;
    this.renderFrame = 0;
    this.lastDpr = 0;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.overlays = {
      boxes: [],
      measurements: [],
      selectedId: null,
      roi: null,
      scaleBox: null,
      showBoxes: true,
    };
    this.theme = this.readTheme();

    this.onPointerDown = (event) => this.pointerDown(event);
    this.onPointerMove = (event) => this.pointerMove(event);
    this.onPointerUp = (event) => this.pointerUp(event);
    this.onPointerCancel = (event) => this.pointerCancel(event);
    this.onPointerLeave = () => {
      if (this.pointerId === null) this.callbacks.onCoordinate?.(null);
    };
    this.onWheel = (event) => this.wheel(event);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeBackingStore();
      this.requestRender();
    });
    this.resizeObserver.observe(container);
    this.resizeBackingStore();
    this.setMode("pan");
  }

  readTheme() {
    const styles = getComputedStyle(document.documentElement);
    return {
      canvas: styles.getPropertyValue("--color-canvas").trim() || "#111715",
      box: styles.getPropertyValue("--viewer-box").trim() || "#35a49a",
      selected:
        styles.getPropertyValue("--viewer-box-selected").trim() || "#f0a33a",
      measure: styles.getPropertyValue("--viewer-measure").trim() || "#61c6b9",
      review:
        styles.getPropertyValue("--viewer-measure-review").trim() || "#f0a33a",
      roi: styles.getPropertyValue("--viewer-roi").trim() || "#72a7f5",
      labelBackground:
        styles.getPropertyValue("--viewer-label-background").trim() ||
        "rgb(8 24 20 / 82%)",
      labelText:
        styles.getPropertyValue("--viewer-label-text").trim() || "#f5fbf9",
    };
  }

  /** @param {string} url */
  load(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        this.image = image;
        this.imageWidth = image.naturalWidth;
        this.imageHeight = image.naturalHeight;
        this.fitToWindow();
        resolve({ width: this.imageWidth, height: this.imageHeight });
      };
      image.onerror = () => {
        const message = "图像内容加载失败，请重新导入";
        this.callbacks.onError?.(message);
        reject(new Error(message));
      };
      image.src = url;
    });
  }

  clear() {
    this.image = null;
    this.imageWidth = 0;
    this.imageHeight = 0;
    this.overlays = {
      boxes: [],
      measurements: [],
      selectedId: null,
      roi: null,
      scaleBox: null,
      showBoxes: true,
    };
    this.canvas.classList.remove("has-scale-overlay");
    this.cancelSelection(false);
    this.requestRender();
  }

  setMode(mode) {
    if (!MODES.has(mode)) return;
    if (mode !== this.mode) this.cancelSelection(false);
    if (this.overlays.scaleBox) {
      this.overlays.scaleBox = null;
      this.canvas.classList.remove("has-scale-overlay");
    }
    this.mode = mode;
    this.canvas.dataset.mode = mode;
    this.callbacks.onMode?.(mode);
    this.callbacks.onInteractionState?.({ mode, pending: false });
    this.requestRender();
  }

  /** Cancel a pending first point without changing the active tool. */
  cancelSelection(notify = true) {
    this.lineAnchor = null;
    this.selectionStart = null;
    this.selectionCurrent = null;
    if (notify)
      this.callbacks.onInteractionState?.({
        mode: this.mode,
        pending: false,
      });
    this.requestRender();
  }

  setOverlays(patch) {
    const changed = Object.entries(patch).some(
      ([key, value]) => this.overlays[key] !== value,
    );
    if (!changed) return false;
    this.overlays = { ...this.overlays, ...patch };
    if (Object.hasOwn(patch, "scaleBox"))
      this.canvas.classList.toggle(
        "has-scale-overlay",
        Boolean(patch.scaleBox),
      );
    this.requestRender();
    return true;
  }

  resizeBackingStore() {
    const rect = this.container.getBoundingClientRect();
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (
      this.canvas.width === width &&
      this.canvas.height === height &&
      this.lastDpr === dpr
    )
      return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.lastDpr = dpr;
    return true;
  }

  fitToWindow() {
    if (!this.image) return;
    const rect = this.container.getBoundingClientRect();
    const padding = 28;
    this.scale = Math.max(
      0.01,
      Math.min(
        (rect.width - padding * 2) / this.imageWidth,
        (rect.height - padding * 2) / this.imageHeight,
      ),
    );
    this.offsetX = (rect.width - this.imageWidth * this.scale) / 2;
    this.offsetY = (rect.height - this.imageHeight * this.scale) / 2;
    this.callbacks.onZoom?.(this.scale);
    this.requestRender();
  }

  zoomBy(factor, center = null) {
    if (!this.image) return;
    const rect = this.container.getBoundingClientRect();
    const cx = center?.x ?? rect.width / 2;
    const cy = center?.y ?? rect.height / 2;
    const oldScale = this.scale;
    const nextScale = Math.min(24, Math.max(0.02, oldScale * factor));
    const imageX = (cx - this.offsetX) / oldScale;
    const imageY = (cy - this.offsetY) / oldScale;
    this.scale = nextScale;
    this.offsetX = cx - imageX * nextScale;
    this.offsetY = cy - imageY * nextScale;
    this.callbacks.onZoom?.(this.scale);
    this.requestRender();
  }

  requestRender() {
    if (this.renderFrame) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.render();
    });
  }

  render() {
    this.resizeBackingStore();
    const context = this.context;
    if (!context) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = this.lastDpr || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = this.theme.canvas;
    context.fillRect(0, 0, rect.width, rect.height);
    if (!this.image) return;

    context.imageSmoothingEnabled = this.scale < 2;
    context.drawImage(
      this.image,
      this.offsetX,
      this.offsetY,
      this.imageWidth * this.scale,
      this.imageHeight * this.scale,
    );
    context.save();
    context.beginPath();
    context.rect(
      this.offsetX,
      this.offsetY,
      this.imageWidth * this.scale,
      this.imageHeight * this.scale,
    );
    context.clip();

    if (this.overlays.showBoxes) this.drawBoxes(context);
    this.drawMeasurements(context);
    if (this.overlays.roi)
      this.drawRectangle(context, this.overlays.roi, this.theme.roi, "ROI");
    if (this.overlays.scaleBox) {
      this.drawRectangle(
        context,
        this.overlays.scaleBox,
        this.theme.selected,
        "比例尺候选",
      );
    }
    this.drawSelection(context);
    context.restore();
  }

  drawBoxes(context) {
    context.font = "600 12px var(--font-mono)";
    context.textBaseline = "bottom";
    this.overlays.boxes.forEach((box, index) => {
      if (!Array.isArray(box) || box.length < 4) return;
      const start = this.imageToScreen(box[0], box[1]);
      const end = this.imageToScreen(box[2], box[3]);
      if (!this.isScreenBoundsVisible(start, end, 26)) return;
      context.strokeStyle = this.theme.box;
      context.lineWidth = 1.5;
      context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      const confidence = Number(box[4]);
      const label = Number.isFinite(confidence)
        ? `CNT ${index + 1} · ${confidence.toFixed(2)}`
        : `CNT ${index + 1}`;
      const width = context.measureText(label).width + 10;
      context.fillStyle = this.theme.labelBackground;
      context.fillRect(
        start.x,
        Math.max(this.offsetY, start.y - 22),
        width,
        20,
      );
      context.fillStyle = this.theme.labelText;
      context.fillText(
        label,
        start.x + 5,
        Math.max(this.offsetY + 16, start.y - 5),
      );
    });
  }

  drawMeasurements(context) {
    this.overlays.measurements.forEach((measurement, index) => {
      const p1 = measurement.p1 || measurement.point1;
      const p2 = measurement.p2 || measurement.point2;
      if (
        !Array.isArray(p1) ||
        !Array.isArray(p2) ||
        p1.length < 2 ||
        p2.length < 2
      )
        return;
      const start = this.imageToScreen(p1[0], p1[1]);
      const end = this.imageToScreen(p2[0], p2[1]);
      if (!this.isScreenBoundsVisible(start, end, 28)) return;
      const selected = measurement.measurement_id === this.overlays.selectedId;
      const included = measurement.included_in_statistics === true;
      const color = selected
        ? this.theme.selected
        : included
          ? this.theme.measure
          : this.theme.review;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = selected ? 3 : 2;
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
      context.beginPath();
      context.arc(start.x, start.y, selected ? 4 : 3, 0, Math.PI * 2);
      context.arc(end.x, end.y, selected ? 4 : 3, 0, Math.PI * 2);
      context.fill();
      context.font = "600 12px var(--font-mono)";
      const diameter = Number(measurement.diameter_nm);
      const label =
        Number.isFinite(diameter) && diameter > 0
          ? `${diameter.toFixed(2)} nm`
          : `M${index + 1}`;
      context.fillStyle = this.theme.labelBackground;
      const labelWidth = context.measureText(label).width + 8;
      context.fillRect(start.x + 5, start.y - 22, labelWidth, 18);
      context.fillStyle = this.theme.labelText;
      context.fillText(label, start.x + 9, start.y - 8);
    });
  }

  drawRectangle(context, roi, color, label) {
    const start = this.imageToScreen(roi[0], roi[1]);
    const end = this.imageToScreen(roi[0] + roi[2], roi[1] + roi[3]);
    if (!this.isScreenBoundsVisible(start, end, 20)) return;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.setLineDash([7, 5]);
    context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    context.setLineDash([]);
    context.fillStyle = color;
    context.font = "600 12px var(--font-mono)";
    context.fillText(label, start.x + 5, start.y + 16);
    context.restore();
  }

  drawSelection(context) {
    if (!this.selectionStart || !this.selectionCurrent || this.mode === "pan")
      return;
    const start = this.imageToScreen(
      this.selectionStart.x,
      this.selectionStart.y,
    );
    const end = this.imageToScreen(
      this.selectionCurrent.x,
      this.selectionCurrent.y,
    );
    context.save();
    context.strokeStyle =
      this.mode === "roi" ? this.theme.roi : this.theme.selected;
    context.fillStyle = context.strokeStyle;
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    if (this.mode === "roi") {
      context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
    } else {
      const distance = Math.hypot(
        this.selectionCurrent.x - this.selectionStart.x,
        this.selectionCurrent.y - this.selectionStart.y,
      );
      if (distance < 0.5) {
        context.setLineDash([]);
        context.beginPath();
        context.arc(start.x, start.y, 6, 0, Math.PI * 2);
        context.stroke();
        context.beginPath();
        context.moveTo(start.x - 10, start.y);
        context.lineTo(start.x + 10, start.y);
        context.moveTo(start.x, start.y - 10);
        context.lineTo(start.x, start.y + 10);
        context.stroke();
      } else {
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
        context.setLineDash([]);
        context.beginPath();
        context.arc(start.x, start.y, 4, 0, Math.PI * 2);
        context.arc(end.x, end.y, 4, 0, Math.PI * 2);
        context.fill();
        const label = `${distance.toFixed(1)} px`;
        const middleX = (start.x + end.x) / 2;
        const middleY = (start.y + end.y) / 2;
        context.font = "600 12px sans-serif";
        const labelWidth = context.measureText(label).width + 10;
        context.fillStyle = this.theme.labelBackground;
        context.fillRect(
          middleX - labelWidth / 2,
          middleY - 24,
          labelWidth,
          18,
        );
        context.fillStyle = this.theme.labelText;
        context.fillText(label, middleX - labelWidth / 2 + 5, middleY - 10);
      }
    }
    context.restore();
  }

  pointerDown(event) {
    if (!this.image || event.button !== 0 || this.pointerId !== null) return;
    const screen = this.eventPoint(event);
    const rawPoint = this.screenToImage(screen.x, screen.y);
    if (!this.isImagePoint(rawPoint)) return;
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.lastPointer = screen;
    this.pointerOrigin = screen;
    this.canvas.classList.add("is-dragging");
    if (this.mode !== "pan") {
      const point = this.screenToImage(screen.x, screen.y, true);
      this.selectionStart =
        LINE_MODES.has(this.mode) && this.lineAnchor ? this.lineAnchor : point;
      this.selectionCurrent = point;
      this.requestRender();
    }
    event.preventDefault();
  }

  pointerMove(event) {
    if (!this.image) return;
    const screen = this.eventPoint(event);
    const rawPoint = this.screenToImage(screen.x, screen.y);
    const imagePoint = this.screenToImage(screen.x, screen.y, true);
    this.callbacks.onCoordinate?.(
      this.isImagePoint(rawPoint) ? imagePoint : null,
    );
    if (event.pointerId !== this.pointerId || !this.lastPointer) {
      if (this.lineAnchor && LINE_MODES.has(this.mode)) {
        this.selectionStart = this.lineAnchor;
        this.selectionCurrent = imagePoint;
        this.requestRender();
      }
      return;
    }
    if (this.mode === "pan") {
      this.offsetX += screen.x - this.lastPointer.x;
      this.offsetY += screen.y - this.lastPointer.y;
      this.lastPointer = screen;
    } else {
      this.selectionCurrent = imagePoint;
    }
    this.requestRender();
  }

  pointerUp(event) {
    if (event.pointerId !== this.pointerId) return;
    const screen = this.eventPoint(event);
    const end = this.screenToImage(screen.x, screen.y, true);
    const start = this.selectionStart;
    const pointerOrigin = this.pointerOrigin || screen;
    const dragged =
      Math.hypot(screen.x - pointerOrigin.x, screen.y - pointerOrigin.y) >=
      DRAG_THRESHOLD_PX;
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.lastPointer = null;
    this.pointerOrigin = null;
    this.canvas.classList.remove("is-dragging");
    if (this.mode !== "pan" && start) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      if (this.mode === "roi") {
        const roi = [
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.abs(dx),
          Math.abs(dy),
        ].map((value) => Math.round(value));
        if (roi[2] >= 3 && roi[3] >= 3)
          this.callbacks.onSelection?.({ type: "roi", roi });
      } else if (LINE_MODES.has(this.mode)) {
        const distance = Math.hypot(dx, dy);
        if (this.lineAnchor || dragged) {
          if (distance >= 1) {
            const detail = {
              type: this.mode,
              p1: [Math.round(start.x), Math.round(start.y)],
              p2: [Math.round(end.x), Math.round(end.y)],
            };
            this.lineAnchor = null;
            this.callbacks.onInteractionState?.({
              mode: this.mode,
              pending: false,
            });
            this.callbacks.onSelection?.(detail);
          } else if (this.lineAnchor) {
            this.selectionStart = this.lineAnchor;
            this.selectionCurrent = this.lineAnchor;
            this.requestRender();
            return;
          }
        } else {
          this.lineAnchor = start;
          this.selectionStart = start;
          this.selectionCurrent = start;
          this.callbacks.onInteractionState?.({
            mode: this.mode,
            pending: true,
            point: [Math.round(start.x), Math.round(start.y)],
          });
          this.requestRender();
          return;
        }
      }
    }
    this.selectionStart = null;
    this.selectionCurrent = null;
    this.requestRender();
  }

  pointerCancel(event) {
    if (event.pointerId !== this.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.lastPointer = null;
    this.pointerOrigin = null;
    if (this.lineAnchor && LINE_MODES.has(this.mode)) {
      this.selectionStart = this.lineAnchor;
      this.selectionCurrent = this.lineAnchor;
    } else {
      this.selectionStart = null;
      this.selectionCurrent = null;
    }
    this.canvas.classList.remove("is-dragging");
    this.requestRender();
  }

  wheel(event) {
    if (!this.image) return;
    event.preventDefault();
    const point = this.eventPoint(event);
    this.zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, point);
  }

  eventPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  screenToImage(x, y, clamp = false) {
    let imageX = (x - this.offsetX) / this.scale;
    let imageY = (y - this.offsetY) / this.scale;
    if (clamp) {
      imageX = Math.min(Math.max(imageX, 0), Math.max(0, this.imageWidth - 1));
      imageY = Math.min(Math.max(imageY, 0), Math.max(0, this.imageHeight - 1));
    }
    return { x: imageX, y: imageY };
  }

  imageToScreen(x, y) {
    return {
      x: this.offsetX + Number(x) * this.scale,
      y: this.offsetY + Number(y) * this.scale,
    };
  }

  isScreenBoundsVisible(start, end, padding = 0) {
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    return !(
      right < -padding ||
      bottom < -padding ||
      left > this.viewportWidth + padding ||
      top > this.viewportHeight + padding
    );
  }

  isImagePoint(point) {
    return (
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < this.imageWidth &&
      point.y < this.imageHeight
    );
  }

  destroy() {
    if (this.renderFrame) window.cancelAnimationFrame(this.renderFrame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }
}
