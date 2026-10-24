(function () {
  "use strict";

  const SCHEMA = "yi-an-jinzhongzi-assessment";
  const VERSION = 1;
  const STORAGE_KEY = "yi-an-jinzhongzi-assessment-v1-2026-10-22";
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const format = value => String(round(value));
  const normalize = (value, max, step, fallback) => {
    if (value === "" || !Number.isFinite(Number(value))) return fallback;
    return round(Math.max(0, Math.min(max, Math.round(Number(value) / step) * step)));
  };

  function createModel(data) {
    const items = data.groups.flatMap(group => group.items);
    const byId = new Map(items.map(item => [item.id, item]));
    const taskIds = new Set(items.flatMap(item => item.tasks.map(task => task.id)));

    function baseline() {
      return {
        schema: SCHEMA, version: VERSION, baselineDate: data.meta.date, updatedAt: null,
        items: Object.fromEntries(items.map(item => [item.id, {
          score: item.score, progress: item.progress, note: ""
        }])),
        completedTasks: []
      };
    }

    function validate(candidate) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
          candidate.schema !== SCHEMA || candidate.version !== VERSION ||
          candidate.baselineDate !== data.meta.date) {
        throw new Error("文件格式、版本或评估基线不匹配。");
      }
      if (!candidate.items || typeof candidate.items !== "object" ||
          Array.isArray(candidate.items) || Object.keys(candidate.items).length !== items.length ||
          Object.keys(candidate.items).some(id => !byId.has(id))) {
        throw new Error("评分记录必须包含全部23个有效子项。");
      }
      const result = baseline();
      for (const item of items) {
        const entry = candidate.items[item.id];
        if (!entry || typeof entry !== "object" ||
            !Number.isFinite(entry.score) || entry.score < 0 || entry.score > item.max ||
            !Number.isInteger(entry.score * 2) ||
            !Number.isInteger(entry.progress) || entry.progress < 0 || entry.progress > 100 ||
            typeof entry.note !== "string" || entry.note.length > 6000) {
          throw new Error(item.id + " 的分数、准备度或备注无效；分数需为0.5分的倍数。");
        }
        result.items[item.id] = { score: entry.score, progress: entry.progress, note: entry.note };
      }
      if (!Array.isArray(candidate.completedTasks) || candidate.completedTasks.length > taskIds.size ||
          candidate.completedTasks.some(id => typeof id !== "string" || !taskIds.has(id)) ||
          new Set(candidate.completedTasks).size !== candidate.completedTasks.length) {
        throw new Error("任务记录包含重复或未知任务。");
      }
      if (candidate.updatedAt !== null && (typeof candidate.updatedAt !== "string" ||
          candidate.updatedAt.length > 40 || !Number.isFinite(Date.parse(candidate.updatedAt)))) {
        throw new Error("记录的更新时间无效。");
      }
      result.completedTasks = [...candidate.completedTasks];
      result.updatedAt = candidate.updatedAt;
      return result;
    }

    function totals(state) {
      const groups = Object.fromEntries(data.groups.map(group => [group.id,
        round(group.items.reduce((sum, item) => sum + state.items[item.id].score, 0))]));
      const professional = round(data.groups.filter(group => group.kind === "professional")
        .reduce((sum, group) => sum + groups[group.id], 0));
      const publicScore = round(data.groups.filter(group => group.kind === "public")
        .reduce((sum, group) => sum + groups[group.id], 0));
      return { groups, professional, public: publicScore, simulation: round(professional * .7 + publicScore * .3) };
    }

    function exportRecord(state) {
      return {
        ...validate(state),
        exportedAt: new Date().toISOString(), project: data.meta.project,
        interpretation: data.meta.status,
        weights: { official: "仅大项满分为官方权重；子项满分是内部拆分", professional: .7, public: .3,
          appliesTo: "现场决赛结构模拟；非AI评审或获奖预测" },
        baseline: { totals: totals(baseline()), items: Object.fromEntries(items.map(item => [item.id, {
          title: item.title, max: item.max, score: item.score, progress: item.progress,
          nextReviewTarget: item.targetScore
        }])) },
        currentTotals: totals(state)
      };
    }
    return { items, byId, taskIds, baseline, validate, totals, exportRecord };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createModel, normalize };
  if (typeof window === "undefined" || !window.ASSESSMENT_DATA) return;

  const data = window.ASSESSMENT_DATA;
  const model = createModel(data);
  const initial = model.baseline();
  const baselineTotals = model.totals(initial);
  let state = model.baseline();
  let storageProblem = "";
  let toastTimer;
  let printingDetails = null;
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const icon = name => '<i data-lucide="' + name + '" aria-hidden="true"></i>';
  const statusNames = { partial: "已有部分证据", planned: "仍属规划", missing: "材料待补", verified: "已有核验" };
  const confidenceNames = { low: "低", medium: "中", high: "高" };
  const inputId = (id, field) => id.replace(".", "-") + "-" + field;
  const percent = (score, max) => format(score / max * 100);

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) state = model.validate(JSON.parse(stored));
  } catch (error) {
    storageProblem = "本地记录未能读取，已显示初始基线";
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }

  function save() {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageProblem = "";
    } catch (error) {
      storageProblem = "未能保存，请导出备份";
    }
    updateSaveStatus();
  }

  function updateSaveStatus() {
    $("saveStatus").textContent = storageProblem || (state.updatedAt ? "已保存到本机" : "初始评估");
    $("saveStatus").title = storageProblem || "记录保存在当前浏览器；跨设备请导出、导入评分记录";
    $("lastUpdated").textContent = state.updatedAt
      ? "本机修订 " + new Date(state.updatedAt).toLocaleString("zh-CN", { hour12: false })
      : "评估基线 2026.10.22";
  }

  function taskMarkup(task) {
    return '<label class="task-line"><input type="checkbox" data-task="' + task.id + '">' +
      '<span><b>' + escape(task.title) + '</b><small>交付：' + escape(task.deliverable) + '</small></span></label>';
  }

  function itemMarkup(item) {
    const scoreId = inputId(item.id, "score");
    const progressId = inputId(item.id, "progress");
    const noteId = inputId(item.id, "note");
    return '<article class="assessment-item" id="' + item.id + '" data-item="' + item.id + '">' +
      '<div class="item-heading"><div class="item-title"><span class="item-id">' + item.id + '</span><h4>' + escape(item.title) + '</h4></div>' +
      '<span class="item-status status-' + item.status + '" title="2026.10.22初评的证据状态">' + statusNames[item.status] + '</span></div>' +
      '<blockquote class="requirement"><b>官方要求</b>' + escape(item.requirement) + '</blockquote>' +
      '<p class="assessment-text"><b>初评判断：</b>' + escape(item.assessment) + '</p>' +
      '<div class="scoring-panel"><div class="score-editor"><div class="editor-label"><label for="' + scoreId + '">当前材料自评分</label><span class="baseline-label">初始 ' + item.score + ' / ' + item.max + ' · 内部分配</span></div>' +
      '<div class="score-input-line"><input id="' + scoreId + '" aria-label="' + item.id + ' ' + escape(item.title) + '自评分" type="number" min="0" max="' + item.max + '" step="0.5" data-field="score" data-id="' + item.id + '"><span>/ ' + item.max + '分</span><span class="score-rate" data-rate="' + item.id + '"></span></div>' +
      '<input class="editor-slider" type="range" min="0" max="' + item.max + '" step="0.5" data-field="score" data-id="' + item.id + '" aria-label="' + item.id + '自评分滑块"></div>' +
      '<div class="progress-editor"><div class="editor-label"><label for="' + progressId + '">材料准备度</label><span class="baseline-label">初始估计 ' + item.progress + '%</span></div>' +
      '<div class="progress-input-line"><input id="' + progressId + '" aria-label="' + item.id + '材料准备度" type="number" min="0" max="100" step="1" data-field="progress" data-id="' + item.id + '"><span>%</span><span class="confidence" title="初评依据充分程度；不代表项目成功概率">初评把握：' + confidenceNames[item.confidence] + '</span></div>' +
      '<input class="editor-slider" type="range" min="0" max="100" step="1" data-field="progress" data-id="' + item.id + '" aria-label="' + item.id + '材料准备度滑块"></div></div>' +
      '<p class="target-line">' + icon("target") + '<span>补齐下列证据后复评参考：<strong>' + item.targetScore + ' / ' + item.max + '</strong></span><span data-target="' + item.id + '"></span></p>' +
      '<details class="evidence-details"><summary>' + icon("chevron-right") + '证据、缺口与下一步交付</summary><div class="evidence-body"><div class="evidence-columns"><div><h5>当前可核查依据</h5><ul class="evidence-list">' +
      item.evidence.map(evidence => '<li>' + (evidence.href ? '<a href="' + escape(evidence.href) + '" target="_blank" rel="noopener">' + escape(evidence.label) + '</a>' : '<strong>' + escape(evidence.label) + '</strong>') + '<p>' + escape(evidence.detail) + '</p></li>').join("") +
      '</ul></div><div><h5>尚缺什么</h5><ul class="gap-list">' + item.gaps.map(gap => '<li>' + escape(gap) + '</li>').join("") + '</ul></div></div>' +
      '<div class="item-tasks"><h5>下一步交付 · 完成后仍需复评</h5>' + item.tasks.map(taskMarkup).join("") + '</div></div></details>' +
      '<div class="review-note"><label for="' + noteId + '">复评备注与新增证据</label><textarea id="' + noteId + '" data-field="note" data-id="' + item.id + '" maxlength="6000" placeholder="记录新增材料、核查日期和调整分数的理由"></textarea></div><p class="print-note" data-print-note="' + item.id + '"></p></article>';
  }

  function render() {
    $("assessmentGroups").innerHTML = data.groups.map(group => '<section class="assessment-group" id="' + group.id + '" aria-labelledby="heading-' + group.id + '"><header class="group-header ' + group.kind + '"><div><p class="group-kicker">' + group.id + ' / ' + (group.kind === "professional" ? "专业评审" : "大众评审") + ' · 官方大项满分 ' + group.max + '</p><h3 id="heading-' + group.id + '">' + escape(group.title) + '</h3><p class="group-summary">' + escape(group.summary) + '</p></div><div class="group-score"><strong data-group-score="' + group.id + '"></strong>/ ' + group.max + '</div></header>' + group.items.map(itemMarkup).join("") + '</section>').join("");
    for (const kind of ["professional", "public"]) {
      $(kind + "Navigation").innerHTML = data.groups.filter(group => group.kind === kind).map(group =>
        '<a href="#' + group.id + '" data-nav="' + group.id + '"><span>' + group.id + '</span>' + escape(group.title) + '<span class="nav-score" data-nav-score="' + group.id + '"></span></a>').join("");
    }
    $("scoreOverview").innerHTML = [
      ["professional", "专业材料自评分", "初始24分 · 官方五大项"],
      ["public", "大众材料自评分", "初始9分 · 官方四大项"],
      ["simulation", "现场结构模拟", "专业70% + 大众30%"]
    ].map(([id, label, sub]) => '<div class="score-cell"><span class="score-label">' + label + '</span><div class="score-value"><strong data-total="' + id + '"></strong><small>/ 100</small></div><p class="score-sub">' + sub + '</p></div>').join("");
    $("dimensionRows").innerHTML = data.groups.map(group => '<tr><td><span class="dimension-kind">' + (group.kind === "professional" ? "专业" : "大众") + '</span><a href="#' + group.id + '">' + escape(group.title) + '</a></td><td><b data-row-score="' + group.id + '"></b> / ' + group.max + '</td><td class="rate-cell"><div class="inline-rate"><div class="progress-track"><i data-bar="' + group.id + '"></i></div><span data-row-rate="' + group.id + '"></span></div></td><td>' + baselineTotals.groups[group.id] + ' / ' + group.max + '</td></tr>').join("");
    $("taskPlan").innerHTML = data.groups.map(group => '<div class="plan-group"><h3>' + group.id + ' ' + escape(group.title) + '<span data-task-count="' + group.id + '"></span></h3>' + group.items.flatMap(item => item.tasks.map(task => '<div class="plan-item"><a href="#' + item.id + '" title="返回对应评分项">' + item.id + '</a>' + taskMarkup(task) + '</div>')).join("") + '</div>').join("");
    syncControls();
    update();
    if (window.lucide) window.lucide.createIcons();
  }

  function syncControls() {
    document.querySelectorAll("[data-field]").forEach(control => {
      control.value = state.items[control.dataset.id][control.dataset.field];
    });
  }

  function update() {
    const totals = model.totals(state);
    document.querySelectorAll("[data-total]").forEach(element => { element.textContent = format(totals[element.dataset.total]); });
    let changed = 0;
    for (const item of model.items) {
      const entry = state.items[item.id];
      if (entry.score !== item.score || entry.progress !== item.progress || entry.note || item.tasks.some(task => state.completedTasks.includes(task.id))) changed++;
      document.querySelector('[data-rate="' + item.id + '"]').textContent = percent(entry.score, item.max) + "%";
      document.querySelector('[data-target="' + item.id + '"]').textContent = entry.score >= item.targetScore
        ? "当前已达参考值；仍须核实证据" : "距参考值 " + format(item.targetScore - entry.score) + "分；不自动加分";
      const note = document.querySelector('[data-print-note="' + item.id + '"]');
      note.textContent = entry.note ? "复评备注：" + entry.note : "";
    }
    for (const group of data.groups) {
      const score = totals.groups[group.id];
      document.querySelector('[data-group-score="' + group.id + '"]').textContent = format(score);
      document.querySelector('[data-nav-score="' + group.id + '"]').textContent = format(score) + "/" + group.max;
      document.querySelector('[data-row-score="' + group.id + '"]').textContent = format(score);
      document.querySelector('[data-row-rate="' + group.id + '"]').textContent = percent(score, group.max) + "%";
      document.querySelector('[data-bar="' + group.id + '"]').style.width = percent(score, group.max) + "%";
      const tasks = group.items.flatMap(item => item.tasks);
      document.querySelector('[data-task-count="' + group.id + '"]').textContent = tasks.filter(task => state.completedTasks.includes(task.id)).length + " / " + tasks.length + "项已记录完成";
    }
    document.querySelectorAll("[data-task]").forEach(control => {
      control.checked = state.completedTasks.includes(control.dataset.task);
      control.closest("label").classList.toggle("done", control.checked);
    });
    $("modifiedCount").textContent = changed ? changed + "个子项有本机修订；初评文字保留为基线" : "2026.10.22 初始基线 · 未修订";
    $("overallTaskCount").textContent = "交付记录 " + state.completedTasks.length + " / " + model.taskIds.size + "项";
    updateSaveStatus();
  }

  const searchable = new Map(model.items.map(item => [item.id, [item.id, item.title, item.requirement,
    item.assessment, ...item.evidence.flatMap(entry => [entry.label, entry.detail]), ...item.gaps,
    ...item.tasks.flatMap(task => [task.title, task.deliverable])].join(" ").toLocaleLowerCase()]));

  function filter() {
    const query = $("search").value.trim().toLocaleLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const kind = document.querySelector('input[name="kind"]:checked').value;
    let visible = 0;
    for (const group of data.groups) {
      let groupVisible = 0;
      for (const item of group.items) {
        const text = searchable.get(item.id) + " " + state.items[item.id].note.toLocaleLowerCase();
        const match = (kind === "all" || kind === group.kind) &&
          (!$("gapOnly").checked || state.items[item.id].score < item.max) && terms.every(term => text.includes(term));
        $(item.id).hidden = !match;
        if (match) groupVisible++;
      }
      $(group.id).hidden = groupVisible === 0;
      visible += groupVisible;
    }
    $("filterCount").textContent = visible === model.items.length ? "全部23项" : "显示 " + visible + " / 23项 · 总分仍按全部子项";
    $("emptyState").hidden = visible !== 0;
    $("clearSearch").hidden = !$("search").value;
  }

  function commitInput(control, final) {
    const { id, field } = control.dataset;
    if (!model.byId.has(id)) return;
    if (field === "note") {
      state.items[id].note = control.value.slice(0, 6000);
    } else {
      const item = model.byId.get(id);
      const value = normalize(control.value, field === "score" ? item.max : 100,
        field === "score" ? .5 : 1, state.items[id][field]);
      state.items[id][field] = value;
      document.querySelectorAll('[data-id="' + id + '"][data-field="' + field + '"]').forEach(input => {
        if (input !== control || final || (control.value !== "" && Number(control.value) !== value)) input.value = value;
      });
    }
    save();
    update();
    // Delay a filter that could hide the focused editor until the edit is committed.
    if (final) filter();
  }

  render();
  filter();
  if (window.matchMedia("(max-width: 800px)").matches) $("navigationDetails").open = false;
  if (storageProblem) toast(storageProblem + "；可导入备份文件。");

  document.addEventListener("input", event => {
    if (event.target.matches("[data-field]")) commitInput(event.target, false);
  });
  document.addEventListener("focusout", event => {
    if (event.target.matches('[data-field]:not([data-field="note"])')) commitInput(event.target, true);
  });
  document.addEventListener("change", event => {
    const control = event.target;
    if (control.matches("[data-field]")) commitInput(control, true);
    if (control.matches("[data-task]")) {
      const checked = new Set(state.completedTasks);
      if (control.checked) checked.add(control.dataset.task); else checked.delete(control.dataset.task);
      state.completedTasks = [...checked];
      save(); update();
    }
    if (control.matches('input[name="kind"], #gapOnly')) filter();
  });
  $("search").addEventListener("input", filter);
  $("clearSearch").addEventListener("click", () => { $("search").value = ""; filter(); $("search").focus(); });

  function updateExpandButton() {
    const allOpen = [...document.querySelectorAll(".evidence-details")].every(detail => detail.open);
    $("expandAll").querySelector("span").textContent = allOpen ? "收起全部依据" : "展开全部依据";
    $("expandAll").setAttribute("aria-expanded", String(allOpen));
  }
  document.querySelectorAll(".evidence-details").forEach(detail => detail.addEventListener("toggle", updateExpandButton));
  $("expandAll").addEventListener("click", () => {
    const details = [...document.querySelectorAll(".evidence-details")];
    const shouldOpen = !details.every(detail => detail.open);
    details.forEach(detail => { detail.open = shouldOpen; });
    updateExpandButton();
  });

  document.addEventListener("click", event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const target = $(link.getAttribute("href").slice(1));
    if (target && (target.closest(".assessment-group")?.hidden || target.hidden)) {
      $("search").value = "";
      document.querySelector('input[name="kind"][value="all"]').checked = true;
      $("gapOnly").checked = false;
      filter();
    }
    if (target?.matches(".assessment-item")) target.querySelector(".evidence-details").open = true;
    if (link.closest("#reportNavigation") && window.matchMedia("(max-width: 800px)").matches) $("navigationDetails").open = false;
  });

  if ("IntersectionObserver" in window) {
    const sections = [$("overview"), $("method"), ...data.groups.map(group => $(group.id)), $("action-plan"), $("sources")];
    const observer = new IntersectionObserver(entries => {
      const entry = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!entry) return;
      document.querySelectorAll("[data-nav]").forEach(link => {
        const active = link.dataset.nav === entry.target.id;
        link.classList.toggle("active", active);
        if (active) link.setAttribute("aria-current", "location"); else link.removeAttribute("aria-current");
      });
    }, { rootMargin: "-90px 0px -65% 0px", threshold: 0 });
    sections.forEach(section => observer.observe(section));
  }

  $("resetButton").addEventListener("click", () => { $("resetDialog").returnValue = "cancel"; $("resetDialog").showModal(); });
  $("resetDialog").addEventListener("close", () => {
    if ($("resetDialog").returnValue !== "confirm") return;
    state = model.baseline();
    save(); syncControls(); update(); filter();
    toast("已恢复初始24分 / 9分评估与全部记录。");
  });

  $("exportButton").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(model.exportRecord(state), null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "易安梦华-金种子杯评分记录-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("已生成评分备份，包含当前记录和初始基线。");
  });
  $("importButton").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 1000000) throw new Error("记录文件不能超过1MB。");
      const imported = model.validate(JSON.parse(await file.text()));
      state = imported;
      save(); syncControls(); update(); filter();
      toast("评分、准备度、任务与备注已导入并保存。");
    } catch (error) {
      toast("导入失败，现有记录保留。" + (error instanceof SyntaxError ? "文件不是有效JSON。" : error.message));
    } finally {
      event.target.value = "";
    }
  });

  function beforePrint() {
    if (printingDetails) return;
    printingDetails = [...document.querySelectorAll(".evidence-details")].map(detail => [detail, detail.open]);
    printingDetails.forEach(([detail]) => { detail.open = true; });
  }
  function afterPrint() {
    if (!printingDetails) return;
    printingDetails.forEach(([detail, open]) => { detail.open = open; });
    printingDetails = null;
    updateExpandButton();
  }
  window.addEventListener("beforeprint", beforePrint);
  window.addEventListener("afterprint", afterPrint);
  $("printButton").addEventListener("click", () => { beforePrint(); window.print(); });
})();
