/**
 * 全新数据库的演示数据（老库只补集合，不覆盖）。
 * 禁配与间隔数值均为系统演示用占位设定，不代表真实药理化学结论。
 */

function seed(nowIso) {
  return {
    rubbings: [
      {
        id: "rubbing_demo",
        code: "TP-清-014",
        source: "地方碑刻残页",
        paperSize: "42x68cm",
        note: "边缘有旧折痕",
        createdAt: nowIso
      }
    ],
    damages: [
      {
        id: "damage_demo_1",
        rubbingId: "rubbing_demo",
        position: "左上角第3列题字旁",
        type: "虫蛀孔",
        beforePhotoUrl: "https://example.local/before-014-1.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: nowIso,
        repairedAt: null
      },
      {
        id: "damage_demo_2",
        rubbingId: "rubbing_demo",
        position: "下边缘中央",
        type: "撕裂",
        beforePhotoUrl: "https://example.local/before-014-2.jpg",
        afterPhotoUrl: "",
        status: "pending",
        repairNote: "",
        batchId: null,
        createdAt: nowIso,
        repairedAt: null
      }
    ],
    batches: [],

    // —— 药剂域 ——
    reagents: [
      {
        id: "reagent_wheat_starch",
        name: "小麦淀粉",
        recordUnit: "g",
        density: 0.58,
        intervalHours: 0,
        note: "演示数据：装密度（g/mL）",
        createdAt: nowIso
      },
      {
        id: "reagent_purified_water",
        name: "纯化水",
        recordUnit: "mL",
        density: 1.0,
        intervalHours: 0,
        note: "",
        createdAt: nowIso
      },
      {
        id: "reagent_alum",
        name: "明矾",
        recordUnit: "g",
        density: 1.72,
        intervalHours: 72,
        note: "演示数据：距上次成功调配需间隔72小时",
        createdAt: nowIso
      },
      {
        id: "reagent_ethanol",
        name: "乙醇",
        recordUnit: "mL",
        density: 0.789,
        intervalHours: 0,
        note: "",
        createdAt: nowIso
      },
      {
        id: "reagent_oxalic",
        name: "草酸",
        recordUnit: "g",
        density: 1.9,
        intervalHours: 0,
        note: "演示数据",
        createdAt: nowIso
      }
    ],
    incompatRules: [
      {
        id: "rule_demo_1",
        a: "reagent_oxalic",
        b: "reagent_wheat_starch",
        reason: "演示禁配：草酸影响淀粉糊化（占位设定）",
        createdAt: nowIso
      },
      {
        id: "rule_demo_2",
        a: "reagent_wheat_starch",
        b: "reagent_ethanol",
        reason: "演示禁配：乙醇使淀粉脱水变性（占位设定）",
        createdAt: nowIso
      }
    ],
    formulas: [
      {
        id: "formula_starch_paste",
        name: "淀粉糨糊",
        description: "托裱用基础糨糊",
        createdAt: nowIso,
        versions: [
          {
            version: "1.0.0",
            status: "deprecated",
            note: "初版，未加明矾",
            components: [
              { reagentId: "reagent_wheat_starch", kind: "mass", amount: 1, unit: "g" },
              { reagentId: "reagent_purified_water", kind: "mass", amount: 6, unit: "g" }
            ],
            createdAt: nowIso,
            activatedAt: null
          },
          {
            version: "1.1.0",
            status: "active",
            note: "加少量明矾防腐",
            components: [
              { reagentId: "reagent_wheat_starch", kind: "percent", amount: 14 },
              { reagentId: "reagent_purified_water", kind: "percent", amount: 84 },
              { reagentId: "reagent_alum", kind: "percent", amount: 2 }
            ],
            createdAt: nowIso,
            activatedAt: nowIso
          }
        ]
      },
      {
        id: "formula_ethanol_cleaner",
        name: "乙醇清洁液",
        description: "表面去污演示配方（体积份）",
        createdAt: nowIso,
        versions: [
          {
            version: "1.0.0",
            status: "active",
            note: "75% 乙醇",
            components: [
              { reagentId: "reagent_ethanol", kind: "percent", amount: 75 },
              { reagentId: "reagent_purified_water", kind: "percent", amount: 25 }
            ],
            createdAt: nowIso,
            activatedAt: nowIso
          }
        ]
      }
    ],
    dispensingOrders: [],
    usages: [],
    // POST 建单幂等：clientToken -> orderId
    clientTokens: {}
  };
}

module.exports = { seed };
