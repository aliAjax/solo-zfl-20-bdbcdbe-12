/**
 * 单位与密度换算（纯函数）。
 *
 * 药剂记录两类单位：
 *   质量：mg, g, kg
 *   体积：mL, L
 * 跨质量/体积换算必须经密度 density（单位 g/mL）：mass = volume * density。
 */

const MASS_FACTOR = {
  // 统一换算到 g
  mg: 1 / 1000,
  g: 1,
  kg: 1000
};

const VOLUME_FACTOR = {
  // 统一换算到 mL
  ml: 1,
  l: 1000
};

/** 归一化单位写法：允许 mL / ml / ML，输出小写，mL -> ml */
function normUnit(unit) {
  return String(unit).toLowerCase();
}

function isMassUnit(unit) {
  return Object.prototype.hasOwnProperty.call(MASS_FACTOR, normUnit(unit));
}

function isVolumeUnit(unit) {
  return Object.prototype.hasOwnProperty.call(VOLUME_FACTOR, normUnit(unit));
}

/** "g" | "mL" | null */
function dimensionOf(unit) {
  if (isMassUnit(unit)) return "g";
  if (isVolumeUnit(unit)) return "mL";
  return null;
}

function assertUnit(unit) {
  if (dimensionOf(unit) === null) {
    throw new Error(`不支持的单位：${unit}（支持 mg/g/kg/mL/L）`);
  }
}

function assertDensity(density) {
  if (typeof density !== "number" || !Number.isFinite(density) || density <= 0) {
    throw new Error("密度必须为正数（g/mL）");
  }
}

/** 同量纲内换算：把 value 从 from 单位换到 to 单位 */
function convertSameDimension(value, from, to) {
  from = normUnit(from);
  to = normUnit(to);
  if (MASS_FACTOR[from] !== undefined && MASS_FACTOR[to] !== undefined) {
    return (value * MASS_FACTOR[from]) / MASS_FACTOR[to];
  }
  if (VOLUME_FACTOR[from] !== undefined && VOLUME_FACTOR[to] !== undefined) {
    return (value * VOLUME_FACTOR[from]) / VOLUME_FACTOR[to];
  }
  throw new Error(`无法在 ${from} 与 ${to} 间换算（量纲不同）`);
}

/**
 * 通用换算：from/to 跨量纲时用密度（g/mL）搭桥。
 * 内部统一走克 <-> 毫升。
 */
function convert(value, from, to, density) {
  assertUnit(from);
  assertUnit(to);
  from = normUnit(from);
  to = normUnit(to);
  if (from === to) return value;

  const fromDim = dimensionOf(from);
  const toDim = dimensionOf(to);
  if (fromDim === toDim) return convertSameDimension(value, from, to);

  // 跨量纲必须给密度
  assertDensity(density);
  // 先把 from 折成克
  let grams;
  if (fromDim === "g") {
    grams = value * MASS_FACTOR[from];
  } else {
    grams = value * VOLUME_FACTOR[from] * density; // mL * g/mL
  }
  // 再从克折成 to
  if (toDim === "g") {
    return grams / MASS_FACTOR[to];
  }
  return grams / density / VOLUME_FACTOR[to];
}

/**
 * 取最小分度对应的小数位：graduation 必须是 1、2、5 开头的十进制分度
 * （如 1、0.5、0.1、0.02、10、100），用于按分度取整与对齐校验。
 */
function decimalsFromGraduation(graduation) {
  if (typeof graduation !== "number" || !Number.isFinite(graduation) || graduation <= 0) {
    throw new Error("最小分度必须为正数");
  }
  const normalized = graduation.toExponential();
  const exp = Number(normalized.split("e")[1]);
  const mantissa = Number(normalized.split("e")[0]);
  // 只接受 1/2/5 系分度
  if (![1, 2, 5].includes(Math.abs(mantissa))) {
    throw new Error(`最小分度必须是 1/2/5 十进制分度，收到：${graduation}`);
  }
  return Math.max(0, -exp);
}

/** 按分度小数位四舍五入，抹掉浮点尾巴 */
function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** value 是否已对齐到 graduation 的整数倍 */
function isAligned(value, graduation) {
  const decimals = decimalsFromGraduation(graduation);
  return Math.abs(value - roundTo(value, decimals)) <= 10 ** -(decimals + 6);
}

module.exports = {
  MASS_FACTOR,
  VOLUME_FACTOR,
  normUnit,
  isMassUnit,
  isVolumeUnit,
  dimensionOf,
  assertUnit,
  assertDensity,
  convert,
  decimalsFromGraduation,
  roundTo,
  isAligned
};
