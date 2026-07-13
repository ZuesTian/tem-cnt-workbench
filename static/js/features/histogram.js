// @ts-check

const NICE_FACTORS = [1, 2, 2.5, 5, 10];

/** @param {number} value @param {number} minimum @param {number} maximum */
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** @param {number[]} sorted @param {number} probability */
export function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * clamp(probability, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/** @param {unknown[]} values */
export function normalizeHistogramValues(values) {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
}

/** @param {number[]} sorted */
export function summarizeDistribution(sorted) {
  if (!sorted.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      q1: null,
      q3: null,
      iqr: null,
      sampleStd: null,
      cvPercent: null,
    };
  }
  const count = sorted.length;
  const mean = sorted.reduce((total, value) => total + value, 0) / count;
  const variance =
    count > 1
      ? sorted.reduce((total, value) => total + (value - mean) ** 2, 0) /
        (count - 1)
      : 0;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const sampleStd = Math.sqrt(variance);
  return {
    count,
    min: sorted[0],
    max: sorted[count - 1],
    mean,
    median: quantile(sorted, 0.5),
    q1,
    q3,
    iqr: q3 === null || q1 === null ? null : q3 - q1,
    sampleStd,
    cvPercent: mean > 0 ? (sampleStd / mean) * 100 : null,
  };
}

/** @param {number} value */
function cleanFloat(value) {
  return Number(value.toPrecision(12));
}

/**
 * Find a readable width close to the statistical target while keeping the
 * rendered chart within its visual bin limits.
 * @param {number} minimum
 * @param {number} maximum
 * @param {number} targetCount
 * @param {number} minBins
 * @param {number} maxBins
 */
function chooseNiceBounds(minimum, maximum, targetCount, minBins, maxBins) {
  const range = maximum - minimum;
  const rawWidth = range / Math.max(1, targetCount);
  const exponent = Math.floor(Math.log10(rawWidth));
  const candidates = [];
  for (let shift = -2; shift <= 2; shift += 1) {
    const magnitude = 10 ** (exponent + shift);
    for (const factor of NICE_FACTORS) {
      const width = cleanFloat(factor * magnitude);
      if (!(width > 0)) continue;
      const lower = cleanFloat(Math.floor(minimum / width) * width);
      const upper = cleanFloat(Math.ceil(maximum / width) * width);
      const count = Math.max(1, Math.round((upper - lower) / width));
      if (count > maxBins) continue;
      candidates.push({
        width,
        lower,
        upper: cleanFloat(lower + count * width),
        count,
      });
    }
  }
  const withinMinimum = candidates.filter((candidate) => candidate.count >= minBins);
  const pool = withinMinimum.length ? withinMinimum : candidates;
  pool.sort((left, right) => {
    const countDistance =
      Math.abs(left.count - targetCount) - Math.abs(right.count - targetCount);
    if (countDistance) return countDistance;
    return Math.abs(left.width - rawWidth) - Math.abs(right.width - rawWidth);
  });
  return pool[0];
}

/** @param {number} value @param {number} width */
export function formatBinNumber(value, width) {
  if (!Number.isFinite(value)) return "—";
  const decimals = clamp(Math.max(0, -Math.floor(Math.log10(width)) + 1), 0, 6);
  return value.toFixed(decimals).replace(/(\.\d*?[1-9])0+$|\.0+$/u, "$1");
}

/**
 * Build numeric histogram bins. Auto mode uses the robust
 * Freedman–Diaconis rule, falling back to Sturges when the IQR collapses.
 * @param {unknown[]} rawValues
 * @param {{mode?:"auto"|"count"|"width", binCount?:number, binWidth?:number, minBins?:number, maxBins?:number}} [options]
 */
export function buildHistogram(rawValues, options = {}) {
  const values = normalizeHistogramValues(rawValues);
  const summary = summarizeDistribution(values);
  if (!values.length) {
    return {
      values,
      summary,
      bins: [],
      binWidth: null,
      lower: null,
      upper: null,
      method: "empty",
      adjusted: false,
    };
  }

  const minimum = values[0];
  const maximum = values[values.length - 1];
  const maxBins = clamp(Math.round(Number(options.maxBins) || 20), 2, 30);
  const minBins = values.length < 5 ? 1 : clamp(Math.round(Number(options.minBins) || 5), 2, maxBins);
  const mode = options.mode || "auto";
  let method = "Freedman–Diaconis";
  let adjusted = false;
  let bounds;

  if (minimum === maximum) {
    const rawWidth = Math.max(Math.abs(minimum) * 0.1, 0.1);
    const exponent = Math.floor(Math.log10(rawWidth));
    const width =
      NICE_FACTORS.find((factor) => factor * 10 ** exponent >= rawWidth) *
      10 ** exponent;
    const lower = cleanFloat(Math.max(0, minimum - width / 2));
    bounds = {
      width: cleanFloat(width),
      lower,
      upper: cleanFloat(lower + width),
      count: 1,
    };
    method = "single-value";
  } else if (mode === "width" && Number(options.binWidth) > 0) {
    let width = Number(options.binWidth);
    let lower = cleanFloat(Math.floor(minimum / width) * width);
    let upper = cleanFloat(Math.ceil(maximum / width) * width);
    let count = Math.max(1, Math.round((upper - lower) / width));
    if (count > maxBins) {
      bounds = chooseNiceBounds(minimum, maximum, maxBins, minBins, maxBins);
      adjusted = true;
    } else {
      upper = cleanFloat(lower + count * width);
      bounds = { width: cleanFloat(width), lower, upper, count };
    }
    method = "manual-width";
  } else if (mode === "count" && Number(options.binCount) > 0) {
    const count = clamp(Math.round(Number(options.binCount)), 1, maxBins);
    const width = (maximum - minimum) / count;
    bounds = {
      width,
      lower: minimum,
      upper: maximum,
      count,
    };
    adjusted = count !== Math.round(Number(options.binCount));
    method = "manual-count";
  } else {
    const q1 = summary.q1;
    const q3 = summary.q3;
    const iqr = q1 === null || q3 === null ? 0 : q3 - q1;
    const fdWidth = (2 * iqr) / Math.cbrt(values.length);
    let targetCount;
    if (Number.isFinite(fdWidth) && fdWidth > 0) {
      targetCount = Math.ceil((maximum - minimum) / fdWidth);
    } else {
      targetCount = Math.ceil(Math.log2(values.length) + 1);
      method = "Sturges";
    }
    targetCount = clamp(targetCount, minBins, maxBins);
    bounds = chooseNiceBounds(
      minimum,
      maximum,
      targetCount,
      minBins,
      maxBins,
    );
  }

  if (!bounds) throw new Error("无法为当前数据生成直方图区间");
  const counts = new Array(bounds.count).fill(0);
  values.forEach((value) => {
    const relative = (value - bounds.lower) / bounds.width;
    const index = Math.min(bounds.count - 1, Math.max(0, Math.floor(relative)));
    counts[index] += 1;
  });
  const bins = counts.map((count, index) => {
    const lower = cleanFloat(bounds.lower + index * bounds.width);
    const upper =
      index === counts.length - 1
        ? bounds.upper
        : cleanFloat(bounds.lower + (index + 1) * bounds.width);
    const lowerLabel = formatBinNumber(lower, bounds.width);
    const upperLabel = formatBinNumber(upper, bounds.width);
    return {
      index,
      lower,
      upper,
      count,
      percent: (count / values.length) * 100,
      label: `${lowerLabel}–${upperLabel}`,
      interval: index === counts.length - 1 ? `[${lowerLabel}, ${upperLabel}]` : `[${lowerLabel}, ${upperLabel})`,
    };
  });

  return {
    values,
    summary,
    bins,
    binWidth: bounds.width,
    lower: bounds.lower,
    upper: bounds.upper,
    method,
    adjusted,
  };
}
