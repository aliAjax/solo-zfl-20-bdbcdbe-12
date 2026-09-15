/**
 * 配方换算（纯函数）：按配方版本的组分比例与目标总量，算出每张调配单上
 * 各组分的实际用量，并处理跨量纲换算、最小分度取整与总和守恒。
 *
 * 组分比例三种写法（components[]）：
 *   { reagentId, kind: "mass",    amount, unit: "g"  }  质量份
 *   { reagentId, kind: "volume",  amount, unit: "mL" }  体积份
 *   { reagentId, kind: "percent", amount }              百分比份
 *
 * 归一化语义（文档化约定）：
 *   - 目标为质量时：mass 份直接计份；volume 份经组分密度折质量份 (m = V·ρ)；
 *     percent 视为质量百分比。
 *   - 目标为体积时：volume 份直接计份；mass 份折体积份 (V = m/ρ)；
 *     percent 视为体积百分比。
 *   - 份额 = 归一后份数 / 总份数；凡涉及非目标量纲的组分必须提供密度。
 *
 * 取整与守恒：
 *   先按份额得到目标单位下的精确量，再按最小分度向下取整，
 *   用 largest-remainder 法把丢掉的分度逐个补回余数最大的组分，
 *   使取整后各分量之和严格等于对齐后的目标总量。
 */

const {
  MASS_FACTOR,
  VOLUME_FACTOR,
  dimensionOf,
  convert,
  decimalsFromGraduation,
  roundTo,
  isAligned
} = require("./units");

/** 组分比例合法性（结构层面；密度/组分存在性由 service 层负责） */
function validateComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    return ["配方至少包含一个组分"];
  }
  const errors = [];
  const seen = new Set();
  components.forEach((comp, i) => {
    const where = `第${i + 1}个组分`;
    if (!comp || typeof comp !== "object") {
      errors.push(`${where}不是对象`);
      return;
    }
    if (!comp.reagentId) errors.push(`${where}缺少 reagentId`);
    if (seen.has(comp.reagentId)) errors.push(`${where}药剂重复：${comp.reagentId}`);
    seen.add(comp.reagentId);

    if (!Number.isFinite(comp.amount) || comp.amount <= 0) {
      errors.push(`${where}比例必须为正数`);
      return;
    }
    if (comp.kind === "mass" || comp.kind === "volume") {
      const dim = comp.kind === "mass" ? "g" : "mL";
      if (dimensionOf(comp.unit) !== dim) {
        errors.push(`${where}单位 ${comp.unit} 与 ${comp.kind} 比例不匹配`);
      }
    } else if (comp.kind === "percent") {
      if (comp.amount <= 0 || comp.amount > 100) {
        errors.push(`${where}百分比必须在 (0,100] 内`);
      }
    } else {
      errors.push(`${where}kind 只能是 mass/volume/percent`);
    }
  });
  // 纯百分比配方必须凑满 100；混份制不做强制。
  if (components.length > 0 && components.every((c) => c && c.kind === "percent")) {
    const sum = components.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    if (Math.abs(sum - 100) > 1e-6) {
      errors.push(`纯百分比配方比例之和必须为100，当前为 ${roundTo(sum, 6)}`);
    }
  }
  return errors;
}

/**
 * 把各组分比例折算成目标量纲下的份数。
 * targetDim: "g"（目标质量）| "mL"（目标体积）
 * reagents: { [id]: { density } }
 */
function normalizeParts(components, targetDim, reagents) {
  const parts = components.map((comp) => {
    const density = reagents[comp.reagentId] && reagents[comp.reagentId].density;
    if (comp.kind === "percent") return comp.amount; // 百分比即目标量纲下的份

    if (comp.kind === "mass") {
      const grams = comp.amount * MASS_FACTOR[comp.unit.toLowerCase()];
      if (targetDim === "g") return grams;
      if (!Number.isFinite(density) || density <= 0) {
        throw new Error(`组分 ${comp.reagentId} 参与体积目标换算需要密度`);
      }
      return grams / density; // 质量折体积份
    }

    // volume
    const ml = comp.amount * VOLUME_FACTOR[comp.unit.toLowerCase()];
    if (targetDim === "mL") return ml;
    if (!Number.isFinite(density) || density <= 0) {
      throw new Error(`组分 ${comp.reagentId} 参与质量目标换算需要密度`);
    }
    return ml * density; // 体积折质量份
  });
  return parts;
}

/**
 * 主入口。入参：
 *   components    配方版本组分
 *   targetAmount  目标总量（>0，且必须对齐 graduation 的整数倍）
 *   targetUnit    目标单位（mg/g/kg/mL/L）
 *   graduation    目标单位的最小分度（1/2/5 十进制分度）
 *   reagents      { [id]: { density, recordUnit } }
 * 返回：
 *   { targetDim, graduation, decimals,
 *     items: [{ reagentId, unit, amount(取整后), exactAmount(份额精确量),
 *               record: { amount, unit }, canonical: { amount, unit } }],
 *     totals: { target, sum, exactSum, diff } }
 */
function computeMix({ components, targetAmount, targetUnit, graduation, reagents }) {
  const errors = validateComponents(components);
  if (errors.length) {
    const e = new Error(errors.join("；"));
    e.errors = errors;
    throw e;
  }
  const targetDim = dimensionOf(targetUnit);
  if (!targetDim) throw new Error(`不支持的目标单位：${targetUnit}`);
  if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
    throw new Error("目标总量必须为正数");
  }
  const decimals = decimalsFromGraduation(graduation);
  if (!isAligned(targetAmount, graduation)) {
    throw new Error(
      `目标总量 ${targetAmount}${targetUnit} 未对齐最小分度 ${graduation}${targetUnit}，请按 ${graduation}${targetUnit} 的整数倍下单`
    );
  }

  const parts = normalizeParts(components, targetDim, reagents);
  const totalParts = parts.reduce((s, p) => s + p, 0);

  // 精确量（目标单位）
  const exact = parts.map((p) => (targetAmount * p) / totalParts);

  // 向下取整到分度
  const floors = exact.map((q) => {
    const units = Math.floor(Math.round((q / graduation) * 1e9) / 1e9);
    return roundTo(units * graduation, decimals);
  });
  // 缺多少个分度（目标对齐 => 必为整数）
  const missingUnits = Math.round(
    ((targetAmount - floors.reduce((s, v) => s + v, 0)) / graduation) * 1e6
  ) / 1e6;
  if (missingUnits < 0) {
    throw new Error("取整内部错误：底量之和超过目标量");
  }

  // largest-remainder：余数从大到小，逐个补一个分度
  const order = exact
    .map((q, i) => ({ i, remainder: q - floors[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const amounts = floors.slice();
  for (let k = 0; k < missingUnits; k++) {
    const idx = order[k % order.length].i;
    amounts[idx] = roundTo(amounts[idx] + graduation, decimals);
  }

  const items = components.map((comp, i) => {
    const reagent = reagents[comp.reagentId] || {};
    const amount = amounts[i];
    const recordUnit = reagent.recordUnit || targetUnit;
    const canonicalUnit = targetDim === "g" ? "g" : "mL";
    return {
      reagentId: comp.reagentId,
      unit: targetUnit,
      graduation,
      amount,
      exactAmount: roundTo(exact[i], 9),
      record: {
        amount: roundTo(convert(amount, targetUnit, recordUnit, reagent.density), 6),
        unit: recordUnit
      },
      canonical: {
        amount: roundTo(convert(amount, targetUnit, canonicalUnit, reagent.density), 9),
        unit: canonicalUnit
      }
    };
  });

  const sum = roundTo(items.reduce((s, it) => s + it.amount, 0), decimals);
  const exactSum = roundTo(exact.reduce((s, q) => s + q, 0), 9);
  return {
    targetDim,
    graduation,
    decimals,
    items,
    totals: {
      target: targetAmount,
      unit: targetUnit,
      sum,
      exactSum,
      diff: roundTo(sum - targetAmount, decimals)
    }
  };
}

module.exports = { validateComponents, normalizeParts, computeMix };
