(() => {
  "use strict";

  const QUADRANTS = [
    { id: 0, title: "重要且紧急", hint: "立即去做", color: "var(--q0)" },
    { id: 1, title: "重要不紧急", hint: "计划去做", color: "var(--q1)" },
    { id: 2, title: "紧急不重要", hint: "尽量减少", color: "var(--q2)" },
    { id: 3, title: "不紧急不重要", hint: "偶尔为之", color: "var(--q3)" },
  ];

  const LS_TASKS = "quadrant.tasks.v1";
  const LS_META = "quadrant.meta.v1";
  const LS_CFG = "quadrant.cfg.v1";

  /** @type {{id:string,title:string,note:string,quadrant:number,isDone:boolean,createdAt:string,completedAt:?string,updatedAt:string,deleted:boolean}[]} */
  let tasks = [];
  let revision = 0;
  let syncTimer = null;
  let pollTimer = null;
  let syncing = false;
  let dirty = false; // local edits pending upload
  let lastSyncAt = null;
  let activeQuadrant = null;
  let editingId = null;
  let editQuadrant = 0;
  // Visible-tab poll: lightweight GET (+304). PUT only when dirty.
  const POLL_MS = 45000;

  const $ = (id) => document.getElementById(id);

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_TASKS) || "[]");
      tasks = Array.isArray(raw) ? raw : [];
    } catch {
      tasks = [];
    }
    try {
      const meta = JSON.parse(localStorage.getItem(LS_META) || "{}");
      revision = Number(meta.revision || 0);
    } catch {
      revision = 0;
    }
  }

  function saveLocal() {
    localStorage.setItem(LS_TASKS, JSON.stringify(tasks));
    localStorage.setItem(LS_META, JSON.stringify({ revision, updatedAt: nowIso() }));
  }

  function loadCfg() {
    try {
      return JSON.parse(localStorage.getItem(LS_CFG) || "{}");
    } catch {
      return {};
    }
  }

  function saveCfg(cfg) {
    localStorage.setItem(LS_CFG, JSON.stringify(cfg));
  }

  function defaultSyncUrl() {
    // When served under /quadrant/, use same origin + path.
    const path = location.pathname.replace(/\/+$/, "");
    if (path.endsWith("/quadrant") || path.includes("/quadrant/")) {
      return location.origin + "/quadrant";
    }
    return location.origin;
  }

  function visibleTasks() {
    return tasks.filter((t) => !t.deleted);
  }

  function openIn(q) {
    return visibleTasks()
      .filter((t) => t.quadrant === q && !t.isDone)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function doneIn(q) {
    return visibleTasks()
      .filter((t) => t.quadrant === q && t.isDone)
      .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  }

  function setStatus(text) {
    $("syncStatus").textContent = text;
  }

  function formatClock(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function statusSynced(rev) {
    lastSyncAt = new Date();
    setStatus(`已同步 ${formatClock(lastSyncAt)} · r${rev}`);
  }

  function renderBoard() {
    const open = visibleTasks().filter((t) => !t.isDone).length;
    const done = visibleTasks().filter((t) => t.isDone).length;
    $("stats").innerHTML = `<span>进行中 ${open}</span><span>已完成 ${done}</span>`;

    $("board").innerHTML = QUADRANTS.map((q) => {
      const list = openIn(q.id);
      const rows = list.length
        ? list
            .slice(0, 3)
            .map(
              (t) => `
          <button type="button" class="preview-row" data-toggle="${t.id}">
            <span class="dot"></span><span>${escapeHtml(t.title)}</span>
          </button>`
            )
            .join("") +
          (list.length > 3 ? `<div class="more">还有 ${list.length - 3} 项…</div>` : "")
        : `<div class="empty">暂无任务</div>`;

      return `
        <article class="card" style="--accent:${q.color}" data-open-q="${q.id}">
          <div class="card-head">
            <h3>${q.title}</h3>
            <span class="badge">${list.length}</span>
          </div>
          <p class="hint-line">${q.hint}</p>
          <div class="preview">${rows}</div>
        </article>`;
    }).join("");
  }

  function renderDetail() {
    if (activeQuadrant == null) return;
    const q = QUADRANTS[activeQuadrant];
    $("detailTitle").textContent = q.title;
    $("detail").style.setProperty("--accent", q.color);

    const open = openIn(q.id);
    const done = doneIn(q.id);
    const row = (t) => `
      <div class="task-row ${t.isDone ? "done" : ""}" style="--accent:${q.color}">
        <button type="button" class="check ${t.isDone ? "on" : ""}" data-toggle="${t.id}" aria-label="完成"></button>
        <div class="task-main" data-edit="${t.id}">
          <div class="title">${escapeHtml(t.title)}</div>
          ${t.note ? `<div class="note">${escapeHtml(t.note)}</div>` : ""}
        </div>
        <button type="button" class="del" data-del="${t.id}">删除</button>
      </div>`;

    $("detailBody").innerHTML = `
      <div class="section-label">未完成 (${open.length})</div>
      <div class="task-list">${open.length ? open.map(row).join("") : '<div class="empty">暂无进行中的任务</div>'}</div>
      ${
        done.length
          ? `<div class="section-label">已完成 (${done.length})</div><div class="task-list">${done.map(row).join("")}</div>`
          : ""
      }`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showSheet(el, on) {
    el.classList.toggle("hidden", !on);
    el.setAttribute("aria-hidden", on ? "false" : "true");
  }

  function openDetail(q) {
    activeQuadrant = q;
    renderDetail();
    showSheet($("detail"), true);
  }

  function closeDetail() {
    activeQuadrant = null;
    showSheet($("detail"), false);
  }

  function renderQuadrantPicker() {
    $("quadrantPicker").innerHTML = QUADRANTS.map(
      (q) => `
      <button type="button" class="q-chip ${editQuadrant === q.id ? "selected" : ""}"
        style="--accent:${q.color}" data-pick="${q.id}">${q.title}</button>`
    ).join("");
  }

  function openEditor(task) {
    editingId = task ? task.id : null;
    editQuadrant = task ? task.quadrant : activeQuadrant != null ? activeQuadrant : 0;
    $("editorTitle").textContent = task ? "编辑任务" : "新建任务";
    $("fieldTitle").value = task ? task.title : "";
    $("fieldNote").value = task ? task.note || "" : "";
    renderQuadrantPicker();
    showSheet($("editor"), true);
    setTimeout(() => $("fieldTitle").focus(), 50);
  }

  function closeEditor() {
    showSheet($("editor"), false);
    editingId = null;
  }

  function upsertLocal(mutator) {
    mutator();
    dirty = true;
    saveLocal();
    renderBoard();
    if (activeQuadrant != null) renderDetail();
    scheduleSync();
  }

  function findTask(id) {
    return tasks.find((t) => t.id === id);
  }

  function toggleTask(id) {
    upsertLocal(() => {
      const t = findTask(id);
      if (!t || t.deleted) return;
      t.isDone = !t.isDone;
      t.completedAt = t.isDone ? nowIso() : null;
      t.updatedAt = nowIso();
    });
  }

  function deleteTask(id) {
    upsertLocal(() => {
      const t = findTask(id);
      if (!t) return;
      t.deleted = true;
      t.updatedAt = nowIso();
    });
  }

  function saveEditor(e) {
    e.preventDefault();
    const title = $("fieldTitle").value.trim();
    if (!title) return;
    const note = $("fieldNote").value.trim();
    upsertLocal(() => {
      if (editingId) {
        const t = findTask(editingId);
        if (!t) return;
        t.title = title;
        t.note = note;
        t.quadrant = editQuadrant;
        t.updatedAt = nowIso();
      } else {
        tasks.push({
          id: uuid(),
          title,
          note,
          quadrant: editQuadrant,
          isDone: false,
          createdAt: nowIso(),
          completedAt: null,
          updatedAt: nowIso(),
          deleted: false,
        });
      }
    });
    closeEditor();
  }

  function parseTs(v) {
    const t = Date.parse(v || "");
    return Number.isFinite(t) ? t : 0;
  }

  function mergeTasks(a, b) {
    const map = new Map();
    for (const t of [...a, ...b]) {
      if (!t || !t.id) continue;
      const prev = map.get(t.id);
      if (!prev || parseTs(t.updatedAt) >= parseTs(prev.updatedAt)) map.set(t.id, t);
    }
    return [...map.values()];
  }

  async function syncNow(manual = false) {
    const cfg = loadCfg();
    const base = (cfg.syncUrl || defaultSyncUrl()).replace(/\/+$/, "");
    const token = (cfg.token || "").trim();
    if (!token) {
      setStatus(manual ? "未配置令牌" : "本地（未配置同步）");
      if (manual) alert("请先在设置里填写访问令牌（每台设备/每个浏览器都要填一次）");
      return false;
    }
    if (syncing) return false;
    syncing = true;
    const quiet = !manual && !dirty;
    if (!quiet) setStatus(dirty ? "上传中…" : "同步中…");
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
      };
      // Conditional GET on background polls; manual sync always downloads once.
      if (!manual && revision > 0) headers["If-None-Match"] = `"${revision}"`;

      const getRes = await fetch(`${base}/api/tasks`, {
        headers,
        cache: "no-store",
      });

      if (getRes.status === 304) {
        // Remote unchanged.
        if (dirty) {
          const putRes = await fetch(`${base}/api/tasks`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ tasks, mode: "merge" }),
            cache: "no-store",
          });
          if (!putRes.ok) throw new Error(`上传失败 HTTP ${putRes.status}`);
          const saved = await putRes.json();
          tasks = saved.tasks || tasks;
          revision = saved.revision || revision;
          dirty = false;
          saveLocal();
          renderBoard();
          if (activeQuadrant != null) renderDetail();
        }
        statusSynced(revision);
        return true;
      }

      if (!getRes.ok) throw new Error(`拉取失败 HTTP ${getRes.status}`);
      const remote = await getRes.json();
      const etag = (getRes.headers.get("ETag") || "").replace(/"/g, "");
      const remoteRev = Number(etag || remote.revision || 0);
      const hadDirty = dirty;
      const merged = mergeTasks(tasks, remote.tasks || []);
      tasks = merged;
      revision = remoteRev || remote.revision || revision;
      saveLocal();

      if (hadDirty) {
        const putRes = await fetch(`${base}/api/tasks`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tasks, mode: "merge" }),
          cache: "no-store",
        });
        if (!putRes.ok) throw new Error(`上传失败 HTTP ${putRes.status}`);
        const saved = await putRes.json();
        tasks = saved.tasks || tasks;
        revision = saved.revision || revision;
        dirty = false;
        saveLocal();
      }

      renderBoard();
      if (activeQuadrant != null) renderDetail();
      statusSynced(revision);
      return true;
    } catch (err) {
      console.error(err);
      setStatus("同步失败（仍可用本地）");
      if (manual) alert(String(err.message || err));
      return false;
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    // Debounce uploads after edits; poll stays slow.
    syncTimer = setTimeout(() => syncNow(false), 1200);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!loadCfg().token) return;
      syncNow(false);
    }, POLL_MS);
  }

  function openSettings() {
    const cfg = loadCfg();
    $("fieldSyncUrl").value = cfg.syncUrl || defaultSyncUrl();
    $("fieldToken").value = cfg.token || "";
    $("settingsMsg").textContent = "";
    const tips = [];
    tips.push(
      '<div class="ios-tip">每个浏览器要单独填一次令牌（Safari / Firefox / Chrome 互不共享设置）。Mac↔iPhone Safari 看起来「自动」是因为 iCloud 钥匙串常会带出同一令牌，且两边都连了服务器。</div>'
    );
    tips.push(
      '<div class="ios-tip">桌面 PWA 无刷新按钮时：打开设置 →「强制刷新客户端」。或删掉主屏幕图标后重新「添加到主屏幕」。</div>'
    );
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (isiOS && !standalone) {
      tips.push(
        '<div class="ios-tip">iPhone：Safari → 分享 →「添加到主屏幕」，再从图标打开。</div>'
      );
    }
    $("settingsMsg").innerHTML = tips.join("");
    showSheet($("settings"), true);
  }

  async function saveSettings() {
    const syncUrl = $("fieldSyncUrl").value.trim().replace(/\/+$/, "");
    const token = $("fieldToken").value.trim();
    saveCfg({ syncUrl, token });
    $("settingsMsg").textContent = "已保存，正在同步…";
    const ok = await syncNow(true);
    $("settingsMsg").textContent = ok ? "同步成功" : "保存了设置，但同步失败，请检查地址/令牌";
  }

  async function forceRefreshClient() {
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {
      console.warn(e);
    }
    // Cache-bust navigation for stubborn iOS PWA shells.
    const url = new URL(location.href);
    url.searchParams.set("_refresh", String(Date.now()));
    location.replace(url.toString());
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ revision, tasks }, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `quadrant-tasks-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"));
        const incoming = Array.isArray(data) ? data : data.tasks || [];
        tasks = mergeTasks(tasks, incoming);
        dirty = true;
        saveLocal();
        renderBoard();
        scheduleSync();
        $("settingsMsg").textContent = `已导入并合并 ${incoming.length} 条`;
      } catch (e) {
        alert("导入失败：" + e);
      }
    };
    reader.readAsText(file);
  }

  function wire() {
    $("board").addEventListener("click", (e) => {
      const t = e.target.closest("[data-toggle]");
      if (t) {
        e.stopPropagation();
        toggleTask(t.getAttribute("data-toggle"));
        return;
      }
      const card = e.target.closest("[data-open-q]");
      if (card) openDetail(Number(card.getAttribute("data-open-q")));
    });

    $("detailBody").addEventListener("click", (e) => {
      const tog = e.target.closest("[data-toggle]");
      if (tog) return toggleTask(tog.getAttribute("data-toggle"));
      const del = e.target.closest("[data-del]");
      if (del) return deleteTask(del.getAttribute("data-del"));
      const ed = e.target.closest("[data-edit]");
      if (ed) {
        const task = findTask(ed.getAttribute("data-edit"));
        if (task) openEditor(task);
      }
    });

    $("btnBack").onclick = closeDetail;
    $("btnAdd").onclick = () => openEditor(null);
    $("btnAddInDetail").onclick = () => openEditor(null);
    $("btnCancelEdit").onclick = closeEditor;
    $("btnSaveEdit").onclick = saveEditor;
    $("editForm").onsubmit = saveEditor;
    $("quadrantPicker").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      editQuadrant = Number(b.getAttribute("data-pick"));
      renderQuadrantPicker();
    });

    $("btnSettings").onclick = openSettings;
    $("btnCloseSettings").onclick = () => showSheet($("settings"), false);
    $("btnSaveSettings").onclick = saveSettings;
    $("btnForceRefresh").onclick = forceRefreshClient;
    $("btnSync").onclick = () => syncNow(true);
    $("btnExport").onclick = exportJson;
    $("btnImport").onclick = () => $("importFile").click();
    $("importFile").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJson(f);
      e.target.value = "";
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncNow(false);
    });
    window.addEventListener("focus", () => syncNow(false));
    window.addEventListener("online", () => syncNow(false));
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  loadLocal();
  wire();
  renderBoard();
  registerSW();
  startPolling();
  const cfg = loadCfg();
  if (cfg.token) {
    syncNow(false);
  } else {
    setStatus("本地（打开设置配置同步）");
    // First visit on this browser: nudge to configure (Safari/Firefox/Chrome each need this).
    setTimeout(() => openSettings(), 400);
  }
})();
