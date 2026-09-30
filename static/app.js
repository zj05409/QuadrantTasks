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

  // Deploy-time config (config.js). On GitHub Pages there is no same-origin API,
  // so the workflow writes the sync server URL there.
  const CONF = window.QUADRANT_CONFIG || {};

  /** @type {{id:string,title:string,note:string,quadrant:number,isDone:boolean,createdAt:string,completedAt:?string,updatedAt:string,deleted:boolean}[]} */
  let tasks = [];
  let revision = 0;
  let syncTimer = null;
  let pollTimer = null;
  let syncing = false;
  let resyncQueued = false; // a sync was requested while one was in flight
  let dirty = false; // local edits pending upload (persisted, survives reloads)
  let localGen = 0; // bumps on every local edit; detects edits made mid-sync
  let activeQuadrant = null;
  let editingId = null;
  let editQuadrant = 0;
  // Visible-tab poll: lightweight GET (+304). PUT only when needed.
  const POLL_MS = 45000;
  // Matches the server's tombstone TTL (server/store.py).
  const TOMBSTONE_TTL_MS = 180 * 24 * 3600 * 1000;

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

  function readJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "null");
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
  }

  function loadLocal() {
    const raw = readJson(LS_TASKS, []);
    tasks = Array.isArray(raw) ? raw.filter((t) => t && t.id) : [];
    const meta = readJson(LS_META, {});
    revision = Number(meta.revision || 0);
    dirty = Boolean(meta.dirty);
  }

  function saveLocal() {
    writeJson(LS_TASKS, tasks);
    writeJson(LS_META, { revision, dirty, updatedAt: nowIso() });
  }

  function loadCfg() {
    return readJson(LS_CFG, {});
  }

  function saveCfg(cfg) {
    writeJson(LS_CFG, cfg);
  }

  function defaultSyncUrl() {
    if (typeof CONF.defaultSyncUrl === "string") return CONF.defaultSyncUrl.replace(/\/+$/, "");
    // Served by the sync server itself (e.g. under /quadrant/): same origin + path.
    return new URL(".", location.href).href.replace(/\/+$/, "");
  }

  function syncBase(cfg = loadCfg()) {
    return (cfg.syncUrl != null ? cfg.syncUrl : defaultSyncUrl()).trim().replace(/\/+$/, "");
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

  function statusSynced() {
    const user = loadCfg().user;
    setStatus(`已同步 ${formatClock(new Date())}${user ? ` · ${user}` : ""}`);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderBoard() {
    const live = visibleTasks();
    const done = live.filter((t) => t.isDone).length;
    $("stats").innerHTML = `<span>进行中 ${live.length - done}</span><span>已完成 ${done}</span>`;

    $("board").innerHTML = QUADRANTS.map((q) => {
      const list = openIn(q.id);
      const rows = list.length
        ? list
            .slice(0, 3)
            .map(
              (t) => `
          <button type="button" class="preview-row" data-toggle="${escapeHtml(t.id)}" title="标记完成">
            <span class="dot"></span><span>${escapeHtml(t.title)}</span>
          </button>`
            )
            .join("") +
          (list.length > 3 ? `<div class="more">还有 ${list.length - 3} 项…</div>` : "")
        : `<div class="empty">暂无任务</div>`;

      return `
        <article class="card" style="--accent:${q.color}" data-open-q="${q.id}" tabindex="0" role="button" aria-label="${q.title}">
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
    const row = (t) => {
      const id = escapeHtml(t.id);
      return `
      <div class="task-row ${t.isDone ? "done" : ""}" style="--accent:${q.color}">
        <button type="button" class="check ${t.isDone ? "on" : ""}" data-toggle="${id}" aria-label="${t.isDone ? "标记未完成" : "标记完成"}"></button>
        <div class="task-main" data-edit="${id}">
          <div class="title">${escapeHtml(t.title)}</div>
          ${t.note ? `<div class="note">${escapeHtml(t.note)}</div>` : ""}
        </div>
        <button type="button" class="del" data-del="${id}">删除</button>
      </div>`;
    };

    $("detailBody").innerHTML = `
      <div class="section-label">未完成 (${open.length})</div>
      <div class="task-list">${open.length ? open.map(row).join("") : '<div class="empty">暂无进行中的任务</div>'}</div>
      ${
        done.length
          ? `<div class="section-label">已完成 (${done.length})</div><div class="task-list">${done.map(row).join("")}</div>`
          : ""
      }`;
  }

  function renderAll() {
    renderBoard();
    if (activeQuadrant != null) renderDetail();
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
        style="--accent:${q.color}" data-pick="${q.id}" aria-pressed="${editQuadrant === q.id}">${q.title}</button>`
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

  function markDirty() {
    dirty = true;
    localGen++;
    saveLocal();
    renderAll();
    scheduleSync();
  }

  function upsertLocal(mutator) {
    mutator();
    markDirty();
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
    const t = findTask(id);
    if (!t || !confirm(`删除「${t.title}」？`)) return;
    upsertLocal(() => {
      t.deleted = true;
      t.updatedAt = nowIso();
    });
  }

  function saveEditor(e) {
    e.preventDefault();
    const title = $("fieldTitle").value.trim();
    if (!title) return $("fieldTitle").focus();
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
        const ts = nowIso();
        tasks.push({
          id: uuid(),
          title,
          note,
          quadrant: editQuadrant,
          isDone: false,
          createdAt: ts,
          completedAt: null,
          updatedAt: ts,
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

  // Last-write-wins by updatedAt, same rule as the server.
  function mergeTasks(a, b) {
    const map = new Map();
    for (const t of [...a, ...b]) {
      if (!t || !t.id) continue;
      const prev = map.get(t.id);
      if (!prev || parseTs(t.updatedAt) >= parseTs(prev.updatedAt)) map.set(t.id, t);
    }
    return [...map.values()];
  }

  function pruneTombstones(list) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    return list.filter((t) => !(t.deleted && parseTs(t.updatedAt) < cutoff));
  }

  // True if `local` holds a live task the server lacks, or a newer version of one.
  // Unknown tombstones are ignored so pruned deletes don't ping-pong between devices.
  function hasLocalChanges(local, remote) {
    const byId = new Map(remote.map((t) => [t.id, t]));
    return local.some((t) => {
      const r = byId.get(t.id);
      return r ? parseTs(t.updatedAt) > parseTs(r.updatedAt) : !t.deleted;
    });
  }

  class HttpError extends Error {
    constructor(status, what) {
      super(status === 401 ? "令牌无效或已失效" : `${what}失败 HTTP ${status}`);
      this.status = status;
    }
  }

  async function syncNow(manual = false) {
    const cfg = loadCfg();
    const base = syncBase(cfg);
    const token = (cfg.token || "").trim();
    if (!token || !base) {
      setStatus(dirty ? "本地（有未同步改动）" : "本地模式");
      if (manual) {
        alert("请先在设置里填写同步地址和访问令牌（每台设备/每个浏览器都要填一次）");
        openSettings();
      }
      return false;
    }
    if (syncing) {
      resyncQueued = true;
      return false;
    }
    syncing = true;
    if (manual || dirty) setStatus(dirty ? "上传中…" : "同步中…");
    const auth = { Authorization: `Bearer ${token}` };
    let ok = false;

    const upload = async () => {
      const gen = localGen;
      const res = await fetch(`${base}/api/tasks`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ tasks, mode: "merge" }),
        cache: "no-store",
      });
      if (!res.ok) throw new HttpError(res.status, "上传");
      const saved = await res.json();
      // Merge rather than overwrite: keeps edits made while the PUT was in flight.
      tasks = mergeTasks(tasks, saved.tasks || []);
      revision = Number(saved.revision || revision);
      dirty = localGen !== gen;
    };

    try {
      const headers = { ...auth };
      // Conditional GET on background polls; manual sync always downloads once.
      if (!manual && revision > 0) headers["If-None-Match"] = `"${revision}"`;
      const res = await fetch(`${base}/api/tasks`, { headers, cache: "no-store" });

      if (res.status === 304) {
        if (dirty) await upload();
      } else {
        if (!res.ok) throw new HttpError(res.status, "拉取");
        const remote = await res.json();
        const remoteTasks = Array.isArray(remote.tasks) ? remote.tasks : [];
        const etag = (res.headers.get("ETag") || "").replace(/"/g, "");
        tasks = pruneTombstones(mergeTasks(tasks, remoteTasks));
        revision = Number(etag || remote.revision || revision);
        if (dirty || hasLocalChanges(tasks, remoteTasks)) await upload();
      }
      saveLocal();
      renderAll();
      statusSynced();
      ok = true;
      return true;
    } catch (err) {
      console.error(err);
      if (err instanceof HttpError) setStatus(err.status === 401 ? "令牌无效，请检查设置" : "同步失败（仍可用本地）");
      else setStatus(navigator.onLine ? "连不上同步服务器（仍可用本地）" : "离线（改动会在联网后上传）");
      if (manual) alert(String(err.message || err));
      return false;
    } finally {
      syncing = false;
      // Edits landed mid-sync: push them now. Failures wait for the next poll /
      // online event instead of hammering an unreachable server.
      if (ok && (dirty || resyncQueued)) scheduleSync();
      resyncQueued = false;
    }
  }

  function scheduleSync(delay = 1200) {
    clearTimeout(syncTimer);
    // Debounce uploads after edits; poll stays slow.
    syncTimer = setTimeout(() => syncNow(false), delay);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!loadCfg().token) return;
      syncNow(false);
    }, POLL_MS);
  }

  // ---- settings / account ------------------------------------------------

  function settingsMsg(text) {
    $("settingsMsg").textContent = text;
  }

  async function refreshSignupBox() {
    const base = $("fieldSyncUrl").value.trim().replace(/\/+$/, "");
    $("signupBox").hidden = true;
    if (!base) return;
    try {
      const res = await fetch(`${base}/api/bootstrap`, { cache: "no-store" });
      if (!res.ok) return;
      const info = await res.json();
      $("signupBox").hidden = !info.signup;
      $("serverInfo").textContent = `服务器版本 ${info.version || "?"}`;
    } catch {
      $("serverInfo").textContent = "";
    }
  }

  function openSettings() {
    const cfg = loadCfg();
    $("fieldSyncUrl").value = syncBase(cfg);
    $("fieldToken").value = cfg.token || "";
    $("accountLine").textContent = cfg.token
      ? `当前账号：${cfg.user || "（未知，保存后刷新）"}`
      : "未登录：任务只保存在本浏览器。";
    $("serverInfo").textContent = "";
    settingsMsg("");
    const tips = [
      "每个浏览器要单独填一次令牌（Safari / Firefox / Chrome 互不共享设置）。",
      "桌面 PWA 无刷新按钮时：用下方「强制刷新客户端」，或删掉主屏幕图标后重新添加。",
    ];
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (isiOS && !standalone) tips.push("iPhone：Safari → 分享 →「添加到主屏幕」，再从图标打开。");
    $("settingsTips").innerHTML = tips.map((t) => `<div class="ios-tip">${t}</div>`).join("");
    showSheet($("settings"), true);
    refreshSignupBox();
  }

  async function fetchUser(base, token) {
    try {
      const res = await fetch(`${base}/api/me`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (res.ok) return (await res.json()).user || "";
    } catch {
      /* offline: keep going, sync will report */
    }
    return "";
  }

  async function applySettings(syncUrl, token) {
    const prev = loadCfg();
    const switched = syncBase(prev) !== syncUrl || (prev.token || "") !== token;
    if (switched) {
      // Different account/server: its revision numbers mean nothing here.
      revision = 0;
      if (
        prev.token &&
        visibleTasks().length &&
        !confirm(
          "你切换了账号或服务器。\n\n确定：把本机现有任务合并进新账号\n取消：清空本机任务，只使用新账号的数据"
        )
      ) {
        tasks = [];
      }
      dirty = tasks.length > 0;
      localGen++;
      saveLocal();
      renderAll();
    }
    const user = syncUrl && token ? await fetchUser(syncUrl, token) : "";
    saveCfg({ ...prev, syncUrl, token, user });
    $("accountLine").textContent = token ? `当前账号：${user || "（未知）"}` : "未登录：任务只保存在本浏览器。";
    if (!syncUrl || !token) {
      settingsMsg("已保存（本地模式）");
      setStatus("本地模式");
      return;
    }
    settingsMsg("已保存，正在同步…");
    const ok = await syncNow(true);
    settingsMsg(ok ? "同步成功" : "保存了设置，但同步失败，请检查地址/令牌");
  }

  function saveSettings() {
    const syncUrl = $("fieldSyncUrl").value.trim().replace(/\/+$/, "");
    const token = $("fieldToken").value.trim();
    return applySettings(syncUrl, token);
  }

  async function signup() {
    const base = $("fieldSyncUrl").value.trim().replace(/\/+$/, "");
    const name = $("fieldSignupName").value.trim().toLowerCase();
    const inviteCode = $("fieldInvite").value.trim();
    if (!base || !name || !inviteCode) return settingsMsg("请填写同步地址、用户名和邀请码");
    try {
      const res = await fetch(`${base}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, inviteCode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`;
        return settingsMsg(`注册失败：${detail}`);
      }
      $("fieldToken").value = body.token;
      $("fieldInvite").value = "";
      await applySettings(base, body.token);
      settingsMsg(`注册成功！请妥善保存令牌（其它设备登录要用）：${body.token}`);
    } catch (e) {
      settingsMsg(`注册失败：${e.message || e}`);
    }
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
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"));
        const incoming = (Array.isArray(data) ? data : data.tasks || []).filter(
          (t) => t && typeof t.id === "string" && typeof t.title === "string"
        );
        tasks = mergeTasks(tasks, incoming);
        markDirty();
        settingsMsg(`已导入并合并 ${incoming.length} 条`);
      } catch (e) {
        alert("导入失败：" + e);
      }
    };
    reader.readAsText(file);
  }

  function closeTopSheet() {
    for (const id of ["editor", "settings", "detail"]) {
      if (!$(id).classList.contains("hidden")) {
        if (id === "editor") closeEditor();
        else if (id === "detail") closeDetail();
        else showSheet($(id), false);
        return true;
      }
    }
    return false;
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
    $("board").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest("[data-open-q]");
      if (card && e.target === card) {
        e.preventDefault();
        openDetail(Number(card.getAttribute("data-open-q")));
      }
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
    $("fieldSyncUrl").addEventListener("change", refreshSignupBox);
    $("btnSignup").onclick = signup;
    $("btnForceRefresh").onclick = forceRefreshClient;
    $("btnSync").onclick = () => syncNow(true);
    $("btnExport").onclick = exportJson;
    $("btnImport").onclick = () => $("importFile").click();
    $("importFile").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJson(f);
      e.target.value = "";
    };

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeTopSheet();
        return;
      }
      // "n" = new task, when not typing and no sheet is open.
      const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "n" && !typing && !e.metaKey && !e.ctrlKey && $("editor").classList.contains("hidden")) {
        e.preventDefault();
        openEditor(null);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncNow(false);
    });
    window.addEventListener("online", () => syncNow(false));
    // Another tab of this app changed localStorage: pick up its state.
    window.addEventListener("storage", (e) => {
      if (e.key === LS_TASKS || e.key === LS_META) {
        loadLocal();
        renderAll();
      }
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  loadLocal();
  wire();
  renderAll();
  registerSW();
  startPolling();
  const cfg = loadCfg();
  if (cfg.token) {
    syncNow(false);
  } else {
    setStatus(dirty || tasks.length ? "本地模式" : "本地模式（设置里可配置同步）");
    // First visit on this browser: nudge once to configure sync.
    if (!cfg.welcomed) {
      saveCfg({ ...cfg, welcomed: true });
      setTimeout(() => openSettings(), 400);
    }
  }
})();
