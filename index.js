"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
const electron = require("electron");
const path = require("path");
const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const pty = require("node-pty");
const http = require("http");
const events = require("events");
const net = require("net");
const util = require("util");
const fsPromises = require("fs/promises");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
let resolvedEnv = null;
async function resolveShellEnv() {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const env = await new Promise((resolve, reject) => {
      child_process.execFile(shell, ["-ilc", "env -0"], { timeout: 5e3 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const parsed = {};
    for (const entry of env.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx > 0) {
        parsed[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
    if (parsed.PATH) {
      resolvedEnv = parsed;
      process.env.PATH = parsed.PATH;
    }
  } catch {
  }
}
function getShellEnv() {
  return resolvedEnv ?? process.env;
}
const AI_TAB_META = {
  pi: { command: "pi" }
};
function createHomeTask(projectId) {
  const tabId = `home-tab-${projectId}`;
  const tab = {
    id: tabId,
    type: "home",
    title: "Home",
    system: "home"
  };
  const task = {
    id: `home-task-${projectId}`,
    name: "Home",
    tabs: { left: [tab], right: [] },
    activeTab: { left: tabId, right: null },
    splitOpen: false,
    splitRatio: 0.5,
    system: "home"
  };
  return { task, tab };
}
function pruneUnusedTags(data) {
  const usedTagIds = /* @__PURE__ */ new Set();
  for (const project of data.projects) {
    for (const tagId of project.tagIds ?? []) {
      usedTagIds.add(tagId);
    }
  }
  const tags = (data.tags ?? []).filter((tag) => usedTagIds.has(tag.id));
  const tagIds = new Set(tags.map((t) => t.id));
  const projects = data.projects.map((project) => ({
    ...project,
    tagIds: (project.tagIds ?? []).filter((id) => tagIds.has(id))
  }));
  return { ...data, tags, projects };
}
function pinKey(projectId, taskId, pane, tabId) {
  return `${projectId}:${taskId}:${pane}:${tabId}`;
}
function collectPinKeys(projects) {
  const keys = [];
  for (const project of projects) {
    for (const task of project.tasks) {
      for (const pane of ["left", "right"]) {
        for (const tab of task.tabs[pane]) {
          if (tab.pinned) keys.push(pinKey(project.id, task.id, pane, tab.id));
        }
      }
    }
  }
  return keys;
}
const DEFAULT_CONFIG = {
  fontFamily: "monospace",
  fontSize: 14,
  theme: "system",
  terminalTheme: "system",
  terminalColorScheme: "auto",
  defaultShell: "",
  copyOnSelect: false,
  editorFontFamily: "monospace",
  editorFontSize: 14,
  editorWordWrap: "off",
  editorLineNumbers: "on",
  editorRenderWhitespace: "selection",
  editorMinimap: false,
  editorTabSize: 4,
  diffRenderSideBySide: true,
  diffIgnoreTrimWhitespace: true,
  enableClaude: false,
  enableCodex: false,
  enablePi: false,
  lazyLoadClaude: true,
  lastProjectId: null,
  lastTaskId: null,
  taskRecencyHighlight: {
    enabled: true,
    mode: "rank",
    rankCount: 5,
    timeWindowMinutes: 1440
  },
  activityPanel: {
    enabled: true,
    heightPx: 160
  }
};
function createTaskViewState(task) {
  return {
    activeTab: {
      left: task.activeTab.left ?? task.tabs.left[task.tabs.left.length - 1]?.id ?? null,
      right: task.activeTab.right ?? task.tabs.right[task.tabs.right.length - 1]?.id ?? null
    },
    splitOpen: task.splitOpen,
    splitRatio: task.splitRatio
  };
}
function createDefaultTaskStates(projects) {
  const taskStates = {};
  for (const project of projects) {
    for (const task of project.tasks) {
      taskStates[task.id] = createTaskViewState(task);
    }
  }
  return taskStates;
}
function createDefaultWindowViewState() {
  return {
    selectedProjectId: null,
    selectedTaskId: null,
    selectedTagIds: [],
    expandedProjectIds: [],
    taskStates: {},
    fileBrowserOpen: false,
    fileBrowserWidth: 250,
    fileBrowserActiveTab: "files",
    watchStripHidden: false,
    pinOrder: []
  };
}
function cloneWindowViewState(state) {
  return {
    selectedProjectId: state.selectedProjectId,
    selectedTaskId: state.selectedTaskId,
    selectedTagIds: [...state.selectedTagIds],
    expandedProjectIds: [...state.expandedProjectIds],
    taskStates: Object.fromEntries(
      Object.entries(state.taskStates).map(([taskId, taskState]) => [
        taskId,
        {
          activeTab: {
            left: taskState.activeTab.left,
            right: taskState.activeTab.right
          },
          splitOpen: taskState.splitOpen,
          splitRatio: taskState.splitRatio,
          ...taskState.fileBrowserOpen !== void 0 ? { fileBrowserOpen: taskState.fileBrowserOpen } : {},
          ...taskState.fileBrowserActiveTab !== void 0 ? { fileBrowserActiveTab: taskState.fileBrowserActiveTab } : {}
        }
      ])
    ),
    fileBrowserOpen: state.fileBrowserOpen,
    fileBrowserWidth: state.fileBrowserWidth,
    fileBrowserActiveTab: state.fileBrowserActiveTab,
    watchStripHidden: state.watchStripHidden,
    pinOrder: [...state.pinOrder ?? []]
  };
}
function cloneWindowGeometry(geometry) {
  return {
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    isMaximized: geometry.isMaximized
  };
}
function clonePersistedWindowState(state) {
  return {
    geometry: cloneWindowGeometry(state.geometry),
    viewState: cloneWindowViewState(state.viewState)
  };
}
function createDefaultWindowSessionState() {
  return { windows: [] };
}
function resolveStoredSelection(projects, config) {
  if (!config.lastProjectId) {
    return { selectedProjectId: null, selectedTaskId: null };
  }
  const project = projects.find((candidate) => candidate.id === config.lastProjectId);
  if (!project) {
    return { selectedProjectId: null, selectedTaskId: null };
  }
  const candidateTaskId = config.lastTaskId ?? project.lastTaskId ?? null;
  const remembered = candidateTaskId && project.tasks.some((task) => task.id === candidateTaskId) ? candidateTaskId : null;
  const homeTask = project.tasks.find((task) => task.system === "home") ?? null;
  const taskId = remembered ?? homeTask?.id ?? null;
  return {
    selectedProjectId: project.id,
    selectedTaskId: taskId
  };
}
function reconcileTaskViewState(task, state) {
  if (task.system === "home") {
    const hasHomeTab = task.tabs.left.some((tab) => tab.system === "home");
    if (!hasHomeTab) {
      const projectId = task.id.startsWith("home-task-") ? task.id.slice("home-task-".length) : task.id;
      const { tab } = createHomeTask(projectId);
      task.tabs.left.unshift(tab);
      if (!task.activeTab.left) task.activeTab.left = tab.id;
    }
  }
  const fallback = createTaskViewState(task);
  if (!state) return fallback;
  const leftIds = new Set(task.tabs.left.map((tab) => tab.id));
  const rightIds = new Set(task.tabs.right.map((tab) => tab.id));
  return {
    activeTab: {
      left: state.activeTab.left === null ? null : leftIds.has(state.activeTab.left) ? state.activeTab.left : fallback.activeTab.left,
      right: state.activeTab.right === null ? null : rightIds.has(state.activeTab.right) ? state.activeTab.right : fallback.activeTab.right
    },
    splitOpen: state.splitOpen,
    splitRatio: state.splitRatio,
    ...state.fileBrowserOpen !== void 0 ? { fileBrowserOpen: state.fileBrowserOpen } : {},
    ...state.fileBrowserActiveTab !== void 0 ? { fileBrowserActiveTab: state.fileBrowserActiveTab } : {}
  };
}
function reconcileWindowViewState(state, projects, tagIds) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const selectedProject = state.selectedProjectId ? projectById.get(state.selectedProjectId) ?? null : null;
  const selectedTask = selectedProject && state.selectedTaskId ? selectedProject.tasks.find((task) => task.id === state.selectedTaskId) ?? null : null;
  const taskStates = {};
  for (const project of projects) {
    for (const task of project.tasks) {
      const nextState = state.taskStates[task.id];
      if (nextState) {
        taskStates[task.id] = reconcileTaskViewState(task, nextState);
      }
    }
  }
  const expandedProjectIds = (state.expandedProjectIds ?? []).filter((id) => projectById.has(id));
  const validTagIds = tagIds ?? /* @__PURE__ */ new Set();
  const selectedTagIds = (state.selectedTagIds ?? []).filter((id) => validTagIds.has(id));
  const currentPinKeys = new Set(collectPinKeys(projects));
  const seenPinKeys = /* @__PURE__ */ new Set();
  const reconciledPinOrder = [];
  for (const key of state.pinOrder ?? []) {
    if (currentPinKeys.has(key) && !seenPinKeys.has(key)) {
      reconciledPinOrder.push(key);
      seenPinKeys.add(key);
    }
  }
  return {
    selectedProjectId: selectedProject?.id ?? null,
    selectedTaskId: selectedTask?.id ?? null,
    selectedTagIds,
    expandedProjectIds,
    taskStates,
    fileBrowserOpen: state.fileBrowserOpen ?? false,
    fileBrowserWidth: state.fileBrowserWidth ?? 250,
    fileBrowserActiveTab: state.fileBrowserActiveTab ?? "files",
    watchStripHidden: typeof state.watchStripHidden === "boolean" ? state.watchStripHidden : false,
    pinOrder: reconciledPinOrder
  };
}
function buildWindowViewState(projects, config, seed, tags = []) {
  const tagIds = new Set(tags.map((t) => t.id));
  const storedSelection = resolveStoredSelection(projects, config);
  const taskStates = createDefaultTaskStates(projects);
  const selectedProjectId = storedSelection.selectedProjectId;
  const selectedTaskId = storedSelection.selectedTaskId;
  const expandedProjectIds = selectedProjectId ? [selectedProjectId] : [];
  return reconcileWindowViewState({
    selectedProjectId,
    selectedTaskId,
    selectedTagIds: [],
    expandedProjectIds,
    taskStates,
    fileBrowserOpen: false,
    fileBrowserWidth: 250,
    fileBrowserActiveTab: "files",
    watchStripHidden: false,
    pinOrder: []
  }, projects, tagIds);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
class Storage {
  configPath;
  projectsPath;
  windowSessionPath;
  constructor(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.configPath = path.join(dir, "config.json");
    this.projectsPath = path.join(dir, "projects.json");
    this.windowSessionPath = path.join(dir, "window-session.json");
  }
  loadConfig() {
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      const { collapsedFolderIds: _legacy, ...rest } = parsed;
      return { ...DEFAULT_CONFIG, ...rest };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  saveConfig(config) {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }
  loadProjects() {
    try {
      const raw = fs.readFileSync(this.projectsPath, "utf-8");
      const data = JSON.parse(raw);
      return Storage.normalizeProjectsData(data);
    } catch {
      return { projects: [], tags: [], projectOrder: [] };
    }
  }
  static normalizeProjectsData(data) {
    const projects = Array.isArray(data.projects) ? data.projects : [];
    const projectIds = new Set(projects.map((p) => p.id));
    const tagIds = new Set(
      (Array.isArray(data.tags) ? data.tags : []).filter((t) => typeof t?.id === "string" && typeof t?.name === "string").map((t) => t.id)
    );
    let tags = Array.isArray(data.tags) ? data.tags.filter(
      (t) => typeof t?.id === "string" && typeof t?.name === "string" && tagIds.has(t.id)
    ) : [];
    let projectOrder = Array.isArray(data.projectOrder) ? data.projectOrder.filter((id) => typeof id === "string" && projectIds.has(id)) : projects.map((p) => p.id);
    const orderSet = new Set(projectOrder);
    for (const p of projects) {
      if (!orderSet.has(p.id)) {
        projectOrder.push(p.id);
        orderSet.add(p.id);
      }
    }
    const normalizedProjects = projects.map((project) => ({
      ...project,
      tagIds: (project.tagIds ?? []).filter((id) => tagIds.has(id))
    }));
    for (const project of normalizedProjects) {
      if (!Array.isArray(project.tasks)) continue;
      for (const task of project.tasks) {
        const legacy = task.lastFocusedAt;
        if (typeof legacy === "number" && task.lastInteractedAt === void 0) {
          task.lastInteractedAt = legacy;
        }
        delete task.lastFocusedAt;
      }
    }
    return pruneUnusedTags({ projects: normalizedProjects, tags, projectOrder });
  }
  saveProjects(data) {
    const normalized = Storage.normalizeProjectsData(data);
    fs.writeFileSync(this.projectsPath, JSON.stringify(normalized, null, 2));
  }
  loadWindowSession(projectsData) {
    try {
      const raw = fs.readFileSync(this.windowSessionPath, "utf-8");
      const data = JSON.parse(raw);
      return Storage.normalizeWindowSessionData(data, projectsData);
    } catch {
      return createDefaultWindowSessionState();
    }
  }
  saveWindowSession(data) {
    fs.writeFileSync(this.windowSessionPath, JSON.stringify(data, null, 2));
  }
  static normalizeWindowSessionData(data, projectsData) {
    if (!isRecord(data) || !Array.isArray(data.windows)) {
      return createDefaultWindowSessionState();
    }
    const tagIds = new Set(projectsData.tags.map((tag) => tag.id));
    const windows = data.windows.map((entry) => Storage.normalizePersistedWindowState(entry, projectsData.projects, tagIds)).filter((entry) => entry !== null);
    return { windows };
  }
  static normalizePersistedWindowState(value, projects, tagIds) {
    if (!isRecord(value)) return null;
    const geometry = Storage.normalizeWindowGeometry(value.geometry);
    if (!geometry) return null;
    const viewState = Storage.normalizeWindowViewState(value.viewState, projects, tagIds);
    return { geometry, viewState };
  }
  static normalizeWindowGeometry(value) {
    if (!isRecord(value)) return null;
    const { x, y, width, height, isMaximized } = value;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) {
      return null;
    }
    return {
      x,
      y,
      width,
      height,
      isMaximized: typeof isMaximized === "boolean" ? isMaximized : false
    };
  }
  static normalizeWindowViewState(value, projects, tagIds) {
    if (!isRecord(value)) {
      return createDefaultWindowViewState();
    }
    const projectIds = new Set(projects.map((p) => p.id));
    const taskStates = Storage.normalizeTaskStates(value.taskStates);
    const legacySelected = Array.isArray(value.selectedTagIds) ? value.selectedTagIds : [];
    const selectedTagIds = legacySelected.filter(
      (id) => typeof id === "string" && tagIds.has(id)
    );
    const expandedProjectIds = Array.isArray(value.expandedProjectIds) ? value.expandedProjectIds.filter((id) => typeof id === "string" && projectIds.has(id)) : [];
    const fileBrowserActiveTab = value.fileBrowserActiveTab === "files" || value.fileBrowserActiveTab === "git" || value.fileBrowserActiveTab === "notes" ? value.fileBrowserActiveTab : "files";
    return reconcileWindowViewState(
      {
        selectedProjectId: typeof value.selectedProjectId === "string" ? value.selectedProjectId : null,
        selectedTaskId: typeof value.selectedTaskId === "string" ? value.selectedTaskId : null,
        selectedTagIds,
        expandedProjectIds,
        taskStates,
        fileBrowserOpen: typeof value.fileBrowserOpen === "boolean" ? value.fileBrowserOpen : false,
        fileBrowserWidth: isFiniteNumber(value.fileBrowserWidth) ? value.fileBrowserWidth : 250,
        fileBrowserActiveTab,
        watchStripHidden: typeof value.watchStripHidden === "boolean" ? value.watchStripHidden : false,
        pinOrder: Array.isArray(value.pinOrder) ? value.pinOrder.filter((k) => typeof k === "string") : []
      },
      projects,
      tagIds
    );
  }
  static normalizeTaskStates(value) {
    if (!isRecord(value)) return {};
    const taskStates = {};
    for (const [taskId, taskState] of Object.entries(value)) {
      if (!isRecord(taskState)) continue;
      const activeTab = isRecord(taskState.activeTab) ? taskState.activeTab : {};
      const fileBrowserActiveTab = taskState.fileBrowserActiveTab === "files" || taskState.fileBrowserActiveTab === "git" || taskState.fileBrowserActiveTab === "notes" ? taskState.fileBrowserActiveTab : void 0;
      taskStates[taskId] = {
        activeTab: {
          left: typeof activeTab.left === "string" ? activeTab.left : null,
          right: typeof activeTab.right === "string" ? activeTab.right : null
        },
        splitOpen: typeof taskState.splitOpen === "boolean" ? taskState.splitOpen : false,
        splitRatio: isFiniteNumber(taskState.splitRatio) ? taskState.splitRatio : 0.5,
        ...typeof taskState.fileBrowserOpen === "boolean" ? { fileBrowserOpen: taskState.fileBrowserOpen } : {},
        ...fileBrowserActiveTab !== void 0 ? { fileBrowserActiveTab } : {}
      };
    }
    return taskStates;
  }
}
class ScrollbackStorage {
  dir;
  constructor(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.dir = dir;
  }
  filePath(tabId) {
    return path.join(this.dir, `${tabId}.txt`);
  }
  save(tabId, data) {
    fs.writeFileSync(this.filePath(tabId), data);
  }
  load(tabId) {
    try {
      return fs.readFileSync(this.filePath(tabId), "utf-8");
    } catch {
      return null;
    }
  }
  delete(tabId) {
    try {
      fs.unlinkSync(this.filePath(tabId));
    } catch {
    }
  }
}
class PtyManager {
  instances = /* @__PURE__ */ new Map();
  spawn(id, shell, cwd, cols, rows, args, extraEnv, callbacks) {
    if (this.instances.has(id)) {
      this.kill(id);
    }
    const proc = pty__namespace.spawn(shell, args ?? [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...getShellEnv(), COLORTERM: "truecolor", ...extraEnv }
    });
    if (callbacks?.onData) {
      proc.onData(callbacks.onData);
    }
    if (callbacks?.onExit) {
      proc.onExit(({ exitCode }) => callbacks.onExit?.(exitCode));
    }
    this.instances.set(id, { process: proc, projectDir: cwd });
  }
  write(id, data) {
    this.instances.get(id)?.process.write(data);
  }
  resize(id, cols, rows) {
    try {
      this.instances.get(id)?.process.resize(cols, rows);
    } catch {
    }
  }
  onData(id, callback) {
    this.instances.get(id)?.process.onData(callback);
  }
  onExit(id, callback) {
    this.instances.get(id)?.process.onExit(({ exitCode }) => callback(exitCode));
  }
  kill(id) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.process.kill();
      this.instances.delete(id);
    }
  }
  killAll() {
    for (const [id] of this.instances) {
      this.kill(id);
    }
  }
}
const VALID_ENDPOINTS = /* @__PURE__ */ new Set(["session-start", "working", "stopped", "notification"]);
class HookServer extends events.EventEmitter {
  server = null;
  port = 0;
  ready = false;
  async start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const match = req.url?.match(/^\/hook\/(.+)$/);
        const endpoint = match?.[1];
        if (!endpoint || !VALID_ENDPOINTS.has(endpoint)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const tabId = req.headers["x-tab-id"];
        if (!tabId) {
          res.writeHead(400);
          res.end();
          return;
        }
        let rawBody = "";
        req.on("data", (chunk) => {
          rawBody += chunk;
        });
        req.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(rawBody);
          } catch {
          }
          if (endpoint === "working" || endpoint === "stopped") {
            this.emit(endpoint, tabId);
          } else {
            this.emit(endpoint, tabId, body);
          }
          res.writeHead(200);
          res.end();
        });
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        this.ready = true;
        resolve();
      });
    });
  }
  getPort() {
    return this.port;
  }
  isReady() {
    return this.ready;
  }
  async stop() {
    return new Promise((resolve) => {
      this.ready = false;
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
const DEVTOOL_HOOK_MARKER = "__devtool_injected";
class HookInjector {
  port;
  refCounts = /* @__PURE__ */ new Map();
  constructor(port) {
    this.port = port;
  }
  /** Identify devtool hooks by marker OR by URL pattern (marker may be stripped by Claude) */
  isDevtoolHook(h) {
    if (h[DEVTOOL_HOOK_MARKER]) return true;
    return h.hooks.some((hook) => /localhost:\d+\/hook\//.test(hook.command));
  }
  buildHooks() {
    const base = `http://localhost:${this.port}`;
    const mkHook = (endpoint) => ({
      matcher: "*",
      hooks: [{
        type: "command",
        command: `curl -s --max-time 5 -X POST ${base}/hook/${endpoint} -H "X-Tab-Id: $DEVTOOL_TAB_ID" -d @- 2>/dev/null; printf Success`
      }],
      [DEVTOOL_HOOK_MARKER]: true
    });
    return {
      SessionStart: [mkHook("session-start")],
      UserPromptSubmit: [mkHook("working")],
      Stop: [mkHook("stopped")],
      Notification: [mkHook("notification")]
    };
  }
  inject(projectDir) {
    const count = this.refCounts.get(projectDir) ?? 0;
    this.refCounts.set(projectDir, count + 1);
    if (count > 0) return;
    const claudeDir = path.join(projectDir, ".claude");
    const settingsPath = path.join(claudeDir, "settings.local.json");
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
    }
    const existingHooks = settings.hooks ?? {};
    const devtoolHooks = this.buildHooks();
    const mergedHooks = { ...existingHooks };
    for (const [event, entries] of Object.entries(devtoolHooks)) {
      const userHooks = (mergedHooks[event] ?? []).filter(
        (h) => !this.isDevtoolHook(h)
      );
      mergedHooks[event] = [...userHooks, ...entries];
    }
    settings.hooks = mergedHooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
  cleanup(projectDir) {
    const count = this.refCounts.get(projectDir) ?? 0;
    if (count <= 0) return;
    if (count > 1) {
      this.refCounts.set(projectDir, count - 1);
      return;
    }
    this.refCounts.delete(projectDir);
    const settingsPath = path.join(projectDir, ".claude", "settings.local.json");
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const hooks = settings.hooks ?? {};
      for (const event of Object.keys(hooks)) {
        hooks[event] = hooks[event].filter(
          (h) => !this.isDevtoolHook(h)
        );
        if (hooks[event].length === 0) {
          delete hooks[event];
        }
      }
      settings.hooks = hooks;
      if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch {
    }
  }
  cleanupAll() {
    for (const dir of [...this.refCounts.keys()]) {
      this.refCounts.set(dir, 1);
      this.cleanup(dir);
    }
  }
  getInjectedDirs() {
    return [...this.refCounts.keys()];
  }
  // --- Remote hook injection ---
  remoteRefCounts = /* @__PURE__ */ new Map();
  remoteKey(projectId, remoteDir) {
    return `${projectId}:${remoteDir}`;
  }
  /** Shell-quote a value for safe interpolation into a remote shell command */
  shellQuote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
  /** Track remote inject ref-count keyed by projectId + remoteDir. Returns true on first inject. */
  remoteInject(projectId, remoteDir) {
    const key = this.remoteKey(projectId, remoteDir);
    const count = this.remoteRefCounts.get(key) ?? 0;
    this.remoteRefCounts.set(key, count + 1);
    return count === 0;
  }
  /** Track remote cleanup ref-count. Returns true when last ref removed. */
  remoteCleanup(projectId, remoteDir) {
    const key = this.remoteKey(projectId, remoteDir);
    const count = this.remoteRefCounts.get(key) ?? 0;
    if (count <= 1) {
      this.remoteRefCounts.delete(key);
      return true;
    }
    this.remoteRefCounts.set(key, count - 1);
    return false;
  }
  /**
   * Build a shell script that merges devtool hooks into remote settings.local.json.
   * Preserves existing user settings and hooks.
   */
  buildRemoteInjectScript(remoteDir, remotePort) {
    const base = `http://localhost:${remotePort}`;
    const mkHookCmd = (endpoint) => `curl -s --max-time 5 -X POST ${base}/hook/${endpoint} -H "X-Tab-Id: $DEVTOOL_TAB_ID" -d @- 2>/dev/null; printf Success`;
    const devtoolHooks = {
      SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: mkHookCmd("session-start") }], [DEVTOOL_HOOK_MARKER]: true }],
      UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: mkHookCmd("working") }], [DEVTOOL_HOOK_MARKER]: true }],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: mkHookCmd("stopped") }], [DEVTOOL_HOOK_MARKER]: true }],
      Notification: [{ matcher: "*", hooks: [{ type: "command", command: mkHookCmd("notification") }], [DEVTOOL_HOOK_MARKER]: true }]
    };
    const hooksJsonB64 = Buffer.from(JSON.stringify(devtoolHooks)).toString("base64");
    const settingsPath = `${remoteDir}/.claude/settings.local.json`;
    const quotedRemoteDir = this.shellQuote(remoteDir);
    const quotedSettingsPath = this.shellQuote(settingsPath);
    return `mkdir -p ${quotedRemoteDir}/.claude && python3 -c "
import json, os, base64
path = ${quotedSettingsPath}
try:
    with open(path) as f: settings = json.load(f)
except: settings = {}
hooks = settings.get('hooks', {})
new_hooks = json.loads(base64.b64decode('${hooksJsonB64}').decode())
marker = '${DEVTOOL_HOOK_MARKER}'
for event in list(hooks.keys()):
    hooks[event] = [h for h in hooks[event] if not h.get(marker) and not any('localhost:' in hk.get('command','') and '/hook/' in hk.get('command','') for hk in h.get('hooks',[]))]
    if not hooks[event]: del hooks[event]
for event, entries in new_hooks.items():
    hooks.setdefault(event, []).extend(entries)
settings['hooks'] = hooks
with open(path, 'w') as f: json.dump(settings, f, indent=2)
"`;
  }
  /**
   * Build a shell script that removes only devtool hooks from remote settings.local.json.
   */
  buildRemoteCleanupScript(remoteDir) {
    const quotedSettingsPath = this.shellQuote(`${remoteDir}/.claude/settings.local.json`);
    return `python3 -c "
import json, os
path = ${quotedSettingsPath}
try:
    with open(path) as f: settings = json.load(f)
except: exit(0)
hooks = settings.get('hooks', {})
marker = '${DEVTOOL_HOOK_MARKER}'
for event in list(hooks.keys()):
    hooks[event] = [h for h in hooks[event] if not h.get(marker) and not any('localhost:' in hk.get('command','') and '/hook/' in hk.get('command','') for hk in h.get('hooks',[]))]
    if not hooks[event]: del hooks[event]
if not hooks: settings.pop('hooks', None)
settings['hooks'] = hooks
with open(path, 'w') as f: json.dump(settings, f, indent=2)
" 2>/dev/null || true`;
  }
}
function shellQuote$1(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function joinRemotePath(remoteDir, relative) {
  if (!remoteDir) return relative;
  return remoteDir.replace(/\/+$/, "") + "/" + relative.replace(/^\/+/, "");
}
function controlSocketPath(socketDir, projectId) {
  return path.join(socketDir, `${projectId}.sock`);
}
function buildReadRemoteFileArgs(socketDir, projectId, config, relativePath) {
  const userHost = `${config.username}@${config.host}`;
  const port = String(config.port ?? 22);
  const sock = controlSocketPath(socketDir, projectId);
  const remotePath = joinRemotePath(config.remoteDir, relativePath);
  const args = ["-S", sock, "-o", "ControlMaster=no", "-p", port];
  if (config.keyFile) args.push("-i", config.keyFile);
  args.push(userHost, "cat", "--", shellQuote$1(remotePath));
  return args;
}
class SshConnectionManager extends events.EventEmitter {
  socketDir;
  hookPort;
  statuses = /* @__PURE__ */ new Map();
  remotePorts = /* @__PURE__ */ new Map();
  configs = /* @__PURE__ */ new Map();
  tunnels = /* @__PURE__ */ new Map();
  tunnelStates = /* @__PURE__ */ new Map();
  socksProxies = /* @__PURE__ */ new Map();
  socksStartPromises = /* @__PURE__ */ new Map();
  connectLocks = /* @__PURE__ */ new Map();
  autoReconnectTimers = /* @__PURE__ */ new Map();
  autoReconnectAttempts = /* @__PURE__ */ new Map();
  autoReconnectEnabled = /* @__PURE__ */ new Set();
  /** Promisified execFile that always returns { stdout, stderr } */
  execFileAsync(cmd, args, opts) {
    return new Promise((resolve, reject) => {
      child_process.execFile(cmd, args, opts, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  }
  constructor(socketDir, hookPort) {
    super();
    this.socketDir = socketDir;
    this.hookPort = hookPort;
  }
  getSocketPath(projectId) {
    return controlSocketPath(this.socketDir, projectId);
  }
  getStatus(projectId) {
    return this.statuses.get(projectId) ?? "disconnected";
  }
  setStatus(projectId, status) {
    this.statuses.set(projectId, status);
    this.emit("status-changed", projectId, status);
  }
  getRemotePort(projectId) {
    return this.remotePorts.get(projectId);
  }
  setRemotePort(projectId, port) {
    this.remotePorts.set(projectId, port);
  }
  getTunnel(projectId) {
    return this.tunnels.get(projectId);
  }
  getTunnelState(projectId) {
    return this.tunnelStates.get(projectId) ?? { status: "inactive" };
  }
  setTunnelState(projectId, status, error) {
    const state = error ? { status, error } : { status };
    this.tunnelStates.set(projectId, state);
    this.emit("tunnel-status-changed", projectId, status, error);
  }
  clearTunnelRuntime(projectId) {
    this.tunnels.delete(projectId);
    this.tunnelStates.delete(projectId);
    this.emit("tunnel-status-changed", projectId, "inactive", void 0);
  }
  clearProject(projectId) {
    this.cancelAutoReconnect(projectId);
    this.statuses.delete(projectId);
    this.remotePorts.delete(projectId);
    this.configs.delete(projectId);
    this.tunnels.delete(projectId);
    this.tunnelStates.delete(projectId);
    this.socksStartPromises.delete(projectId);
    const socksEntry = this.socksProxies.get(projectId);
    if (socksEntry) {
      try {
        socksEntry.process.kill();
      } catch {
      }
      this.socksProxies.delete(projectId);
    }
  }
  /** Args to establish the ControlMaster connection (no port forwarding yet). */
  buildMasterArgs(projectId, config) {
    const args = [
      "-fN",
      "-M",
      "-S",
      this.getSocketPath(projectId),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "TCPKeepAlive=yes",
      "-p",
      String(config.port)
    ];
    if (config.keyFile) {
      args.push("-i", config.keyFile);
    }
    args.push(`${config.username}@${config.host}`);
    return args;
  }
  /** Args to add dynamic remote port forwarding via the existing master socket.
   *  Uses `-O forward` so the allocated port is printed to stdout reliably. */
  buildForwardArgs(projectId, config) {
    return [
      "-S",
      this.getSocketPath(projectId),
      "-O",
      "forward",
      "-R",
      `0:localhost:${this.hookPort}`,
      `${config.username}@${config.host}`
    ];
  }
  formatTunnelSpec(tunnel) {
    return `${tunnel.sourcePort}:${tunnel.host}:${tunnel.destinationPort}`;
  }
  buildTunnelForwardArgs(projectId, config, tunnel) {
    return [
      ...this.buildBaseArgs(projectId, config),
      "-O",
      "forward",
      "-L",
      this.formatTunnelSpec(tunnel),
      `${config.username}@${config.host}`
    ];
  }
  buildTunnelCancelArgs(projectId, config, tunnel) {
    return [
      ...this.buildBaseArgs(projectId, config),
      "-O",
      "cancel",
      "-L",
      this.formatTunnelSpec(tunnel),
      `${config.username}@${config.host}`
    ];
  }
  /** Build common SSH args shared across spawn/check/exit (socket, port, keyFile). */
  buildBaseArgs(projectId, config) {
    const args = [
      "-S",
      this.getSocketPath(projectId),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(config.port)
    ];
    if (config.keyFile) {
      args.push("-i", config.keyFile);
    }
    return args;
  }
  buildSpawnArgs(projectId, config, command, commandArgs, envVars, commandPrefix, cwdOverride) {
    const args = [
      ...this.buildBaseArgs(projectId, config),
      "-t",
      `${config.username}@${config.host}`
    ];
    const envPrefix = envVars ? Object.entries(envVars).map(([k, v]) => `${k}=${shellQuote$1(v)}`).join(" ") + " " : "";
    const cmdSuffix = commandArgs?.length ? " " + commandArgs.map((a) => shellQuote$1(a)).join(" ") : "";
    const prefix = commandPrefix || "";
    const cwd = cwdOverride || config.remoteDir;
    const innerCmd = `${prefix}cd ${shellQuote$1(cwd)} && ${envPrefix}exec ${command}${cmdSuffix}`;
    args.push(`bash -l -c ${shellQuote$1(innerCmd)}`);
    return args;
  }
  buildCheckArgs(projectId, config) {
    return [
      ...this.buildBaseArgs(projectId, config),
      "-O",
      "check",
      `${config.username}@${config.host}`
    ];
  }
  buildExitArgs(projectId, config) {
    return [
      ...this.buildBaseArgs(projectId, config),
      "-O",
      "exit",
      `${config.username}@${config.host}`
    ];
  }
  buildSocksProxyArgs(_projectId, config, localPort) {
    const args = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(config.port),
      "-D",
      String(localPort),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes"
    ];
    if (config.keyFile) {
      args.push("-i", config.keyFile);
    }
    args.push(`${config.username}@${config.host}`);
    return args;
  }
  getConfig(projectId) {
    return this.configs.get(projectId);
  }
  getSocksProxy(projectId) {
    const entry = this.socksProxies.get(projectId);
    return entry ? { port: entry.port } : void 0;
  }
  findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = addr.port;
        server.close(() => resolve(port));
      });
      server.on("error", reject);
    });
  }
  waitForPort(port, timeoutMs = 5e3) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tryConnect = () => {
        if (Date.now() > deadline) {
          reject(new Error(`SOCKS proxy did not become ready on port ${port} within ${timeoutMs}ms`));
          return;
        }
        const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
          sock.destroy();
          resolve();
        });
        sock.on("error", () => {
          setTimeout(tryConnect, 100);
        });
      };
      tryConnect();
    });
  }
  async startSocksProxy(projectId, config) {
    const existing = this.socksProxies.get(projectId);
    if (existing) return existing.port;
    const pending = this.socksStartPromises.get(projectId);
    if (pending) return pending;
    if (this.getStatus(projectId) !== "connected") {
      throw new Error("SSH connection not established");
    }
    const startPromise = this.doStartSocksProxy(projectId, config, 0);
    this.socksStartPromises.set(projectId, startPromise);
    try {
      const port = await startPromise;
      return port;
    } finally {
      this.socksStartPromises.delete(projectId);
    }
  }
  async doStartSocksProxy(projectId, config, attempt) {
    const port = await this.findFreePort();
    const args = this.buildSocksProxyArgs(projectId, config, port);
    const child = child_process.spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err;
    });
    try {
      await this.waitForPort(port);
    } catch {
      child.kill();
      if (spawnError) {
        throw new Error(`Failed to spawn ssh: ${spawnError.message}`);
      }
      if (attempt < 1 && !stderr.includes("Permission denied") && !stderr.includes("Connection refused")) {
        return this.doStartSocksProxy(projectId, config, attempt + 1);
      }
      throw new Error(`SOCKS proxy failed to start on port ${port}${stderr ? ": " + stderr.slice(0, 200) : ""}`);
    }
    this.socksProxies.set(projectId, { port, process: child });
    child.on("exit", () => {
      if (this.socksProxies.has(projectId)) {
        this.socksProxies.delete(projectId);
        this.emit("socks-proxy-status-changed", projectId, false);
      }
    });
    return port;
  }
  async stopSocksProxy(projectId) {
    const entry = this.socksProxies.get(projectId);
    if (!entry) return;
    this.socksProxies.delete(projectId);
    entry.process.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          entry.process.kill("SIGKILL");
        } catch {
        }
        resolve();
      }, 3e3);
      entry.process.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  /** Return all currently-connected project configs (used for cleanup on shutdown). */
  getConnectedProjects() {
    const connected = /* @__PURE__ */ new Map();
    for (const [projectId, config] of this.configs.entries()) {
      if (this.getStatus(projectId) === "connected") {
        connected.set(projectId, config);
      }
    }
    return connected;
  }
  async connect(projectId, config) {
    const existing = this.connectLocks.get(projectId);
    if (existing) {
      await existing.catch(() => {
      });
      if (this.getStatus(projectId) === "connected") return;
    }
    const promise = this.doConnect(projectId, config);
    this.connectLocks.set(projectId, promise);
    try {
      await promise;
    } finally {
      if (this.connectLocks.get(projectId) === promise) {
        this.connectLocks.delete(projectId);
      }
    }
  }
  async doConnect(projectId, config) {
    if (!fs.existsSync(this.socketDir)) {
      fs.mkdirSync(this.socketDir, { recursive: true });
    }
    this.stopHealthCheck(projectId);
    this.cancelPendingAutoReconnect(projectId);
    const socketPath = this.getSocketPath(projectId);
    if (fs.existsSync(socketPath)) {
      try {
        await this.execFileAsync("ssh", this.buildExitArgs(projectId, config), { timeout: 5e3 });
      } catch {
      }
      try {
        fs.unlinkSync(socketPath);
      } catch {
      }
    }
    this.setStatus(projectId, "connecting");
    this.configs.set(projectId, config);
    try {
      const masterArgs = this.buildMasterArgs(projectId, config);
      await this.execFileAsync("ssh", masterArgs, { timeout: 3e4 });
      const forwardArgs = this.buildForwardArgs(projectId, config);
      const { stdout } = await this.execFileAsync("ssh", forwardArgs, { timeout: 1e4 });
      const portMatch = stdout.match(/Allocated port (\d+)/) || stdout.trim().match(/^(\d+)$/);
      if (!portMatch) {
        await this.execFileAsync("ssh", this.buildExitArgs(projectId, config), { timeout: 5e3 }).catch(() => {
        });
        this.setStatus(projectId, "disconnected");
        this.configs.delete(projectId);
        throw new Error("SSH master connected but remote port forwarding was not allocated — stdout: " + stdout.slice(0, 200));
      }
      this.setRemotePort(projectId, parseInt(portMatch[1], 10));
      this.setStatus(projectId, "connected");
      this.autoReconnectEnabled.add(projectId);
      this.autoReconnectAttempts.delete(projectId);
    } catch (err) {
      this.setStatus(projectId, "disconnected");
      this.configs.delete(projectId);
      if (this.autoReconnectEnabled.has(projectId)) {
        this.scheduleAutoReconnect(projectId, config);
      }
      throw err;
    }
  }
  async disconnect(projectId, config) {
    this.stopHealthCheck(projectId);
    await this.stopSocksProxy(projectId);
    this.clearTunnelRuntime(projectId);
    const args = this.buildExitArgs(projectId, config);
    try {
      await this.execFileAsync("ssh", args, { timeout: 5e3 });
    } catch {
    }
    const socketPath = this.getSocketPath(projectId);
    try {
      fs.unlinkSync(socketPath);
    } catch {
    }
    this.clearProject(projectId);
  }
  async setTunnel(projectId, config, tunnel) {
    if (this.getStatus(projectId) !== "connected") {
      throw new Error("SSH connection not established");
    }
    const previousTunnel = this.tunnels.get(projectId);
    if (previousTunnel) {
      try {
        await this.execFileAsync("ssh", this.buildTunnelCancelArgs(projectId, config, previousTunnel), { timeout: 5e3 });
      } catch {
      }
      this.tunnels.delete(projectId);
    }
    if (!tunnel) {
      this.clearTunnelRuntime(projectId);
      return;
    }
    try {
      await this.execFileAsync("ssh", this.buildTunnelForwardArgs(projectId, config, tunnel), { timeout: 1e4 });
      this.tunnels.set(projectId, tunnel);
      this.setTunnelState(projectId, "active");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setTunnelState(projectId, "error", message);
      throw new Error(`Failed to establish tunnel: ${message}`);
    }
  }
  async readRemoteFile(projectId, config, relativePath) {
    const status = this.getStatus(projectId);
    if (status !== "connected") {
      const err = new Error("ssh-not-connected");
      err.code = "SSH_NOT_CONNECTED";
      throw err;
    }
    const args = buildReadRemoteFileArgs(this.socketDir, projectId, config, relativePath);
    try {
      const { stdout } = await this.execFileAsync("ssh", args, { timeout: 1e4 });
      return stdout;
    } catch (err) {
      if (err && typeof err === "object" && (err.code === 1 || err.code === 2)) return null;
      if (typeof err?.stderr === "string" && /No such file/i.test(err.stderr)) return null;
      throw err;
    }
  }
  async checkConnection(projectId, config) {
    const args = this.buildCheckArgs(projectId, config);
    try {
      await this.execFileAsync("ssh", args, { timeout: 5e3 });
      return true;
    } catch {
      return false;
    }
  }
  healthCheckTimers = /* @__PURE__ */ new Map();
  /** Short-circuit the 10s health check poll when we have direct evidence the
   *  tunnel is dead (e.g., a slave PTY printed "Shared connection to ... closed").
   *  `ssh -O check` can falsely report the master as alive when the master
   *  process survives but its TCP connection to the server has died, so we
   *  don't rely on it here — we just tear everything down and let Layer 2
   *  auto-reconnect take over immediately. */
  triggerReconnect(projectId, config) {
    if (this.getStatus(projectId) !== "connected") return;
    this.stopHealthCheck(projectId);
    this.clearTunnelRuntime(projectId);
    this.setStatus(projectId, "disconnected");
    if (this.autoReconnectEnabled.has(projectId)) {
      this.scheduleAutoReconnect(projectId, config);
    }
  }
  startHealthChecks(projectId, config, intervalMs = 1e4) {
    this.stopHealthCheck(projectId);
    const timer = setInterval(async () => {
      if (this.getStatus(projectId) !== "connected") {
        this.stopHealthCheck(projectId);
        return;
      }
      const ok = await this.checkConnection(projectId, config);
      if (!ok) {
        this.clearTunnelRuntime(projectId);
        this.setStatus(projectId, "disconnected");
        this.stopHealthCheck(projectId);
        if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config);
        }
      }
    }, intervalMs);
    this.healthCheckTimers.set(projectId, timer);
  }
  /** Schedule an auto-reconnect attempt with exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s).
   *  Chains on failure; stops when the connect succeeds or auto-reconnect is cancelled
   *  (explicit disconnect, clearProject, or a competing manual connect). */
  scheduleAutoReconnect(projectId, config) {
    if (this.autoReconnectTimers.has(projectId)) return;
    const attempts = this.autoReconnectAttempts.get(projectId) ?? 0;
    const delay = Math.min(1e3 * Math.pow(2, attempts), 3e4);
    const timer = setTimeout(async () => {
      this.autoReconnectTimers.delete(projectId);
      if (!this.autoReconnectEnabled.has(projectId)) return;
      this.autoReconnectAttempts.set(projectId, attempts + 1);
      try {
        await this.connect(projectId, config);
        if (this.getStatus(projectId) === "connected") {
          this.autoReconnectAttempts.delete(projectId);
          this.startHealthChecks(projectId, config);
        } else if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config);
        }
      } catch {
        if (this.autoReconnectEnabled.has(projectId)) {
          this.scheduleAutoReconnect(projectId, config);
        }
      }
    }, delay);
    this.autoReconnectTimers.set(projectId, timer);
  }
  /** Cancel a pending auto-reconnect timer but keep the intent to auto-reconnect.
   *  Used when a manual connect is starting — we don't want a stale timer to race,
   *  but we do want auto-reconnect to resume if the manual attempt itself fails. */
  cancelPendingAutoReconnect(projectId) {
    const timer = this.autoReconnectTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.autoReconnectTimers.delete(projectId);
    }
    this.autoReconnectAttempts.delete(projectId);
  }
  /** Fully stop auto-reconnect for a project — used on explicit disconnect. */
  cancelAutoReconnect(projectId) {
    this.autoReconnectEnabled.delete(projectId);
    this.cancelPendingAutoReconnect(projectId);
  }
  stopHealthCheck(projectId) {
    const timer = this.healthCheckTimers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(projectId);
    }
  }
  stopHealthChecks() {
    for (const projectId of [...this.healthCheckTimers.keys()]) {
      this.stopHealthCheck(projectId);
    }
  }
  async disconnectAll() {
    this.stopHealthChecks();
    const entries = [...this.configs.entries()];
    await Promise.allSettled(
      entries.map(([projectId, config]) => this.disconnect(projectId, config))
    );
  }
}
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");
class CodexSessionManager {
  sharedHome;
  sqlite3Missing = false;
  constructor(sharedHome = DEFAULT_CODEX_HOME) {
    this.sharedHome = sharedHome;
  }
  findStateDbs() {
    let entries;
    try {
      entries = fs.readdirSync(this.sharedHome);
    } catch {
      return [];
    }
    const dbs = [];
    for (const name of entries) {
      const m = /^state_(\d+)\.sqlite$/.exec(name);
      if (!m) continue;
      dbs.push({ path: path.join(this.sharedHome, name), n: parseInt(m[1], 10) });
    }
    dbs.sort((a, b) => b.n - a.n);
    return dbs.map((d) => d.path);
  }
  async readLatestSessionId(cwd, afterTs = 0) {
    if (this.sqlite3Missing) return null;
    const dbPaths = this.findStateDbs();
    if (dbPaths.length === 0) return null;
    const escapedCwd = cwd.replace(/'/g, "''");
    const safeAfterTs = Number.isFinite(afterTs) ? Math.floor(afterTs) : 0;
    const sql = `SELECT id FROM threads WHERE cwd = '${escapedCwd}' AND created_at >= ${safeAfterTs} ORDER BY created_at DESC LIMIT 1`;
    for (const dbPath of dbPaths) {
      const result = await this.queryDb(dbPath, sql);
      if (result !== void 0) return result;
    }
    return null;
  }
  /**
   * Query a single state DB. Returns:
   * - string: session ID found
   * - null: query succeeded but no results, or sqlite3 binary missing (ENOENT)
   * - undefined: DB-level error, caller should try next DB
   */
  queryDb(dbPath, sql) {
    return new Promise((resolve) => {
      child_process.execFile("sqlite3", ["-readonly", dbPath, sql], { encoding: "utf-8", timeout: 3e3 }, (err, stdout) => {
        if (err) {
          if (err.code === "ENOENT") {
            this.sqlite3Missing = true;
            resolve(null);
            return;
          }
          resolve(void 0);
          return;
        }
        const id = stdout.trim();
        resolve(id || null);
      });
    });
  }
  buildRemoteReadSessionScript(cwd, afterTs = 0) {
    const safeAfterTs = Number.isFinite(afterTs) ? Math.floor(afterTs) : 0;
    const payloadB64 = Buffer.from(JSON.stringify({ cwd, afterTs: safeAfterTs }), "utf8").toString("base64");
    const script = `
import base64, glob, json, os, re, sqlite3

data = json.loads(base64.b64decode('${payloadB64}').decode())
home = os.path.expanduser('~/.codex')
dbs = glob.glob(os.path.join(home, 'state_*.sqlite'))

def db_num(p):
    m = re.search(r'state_(\\d+)\\.sqlite$', p)
    return int(m.group(1)) if m else -1

dbs.sort(key=db_num, reverse=True)

sessionId = None
for db in dbs:
    try:
        conn = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
        row = conn.execute(
            'SELECT id FROM threads WHERE cwd = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1',
            (data['cwd'], data.get('afterTs', 0))
        ).fetchone()
        conn.close()
        if row:
            sessionId = row[0]
            break
    except Exception:
        continue

print(json.dumps({'sessionId': sessionId}))
`.trim();
    return `python3 -c ${this.shellQuote(script)}`;
  }
  shellQuote(value) {
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }
}
class RemoteWorkspaceManager {
  execFileAsync(command, args, timeout) {
    return new Promise((resolve, reject) => {
      child_process.execFile(command, args, { timeout }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
  shellQuote(value) {
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }
  async runRemote(socketPath, projectId, sshConfig, payload, script) {
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const wrappedScript = `
import base64, json

payload = json.loads(base64.b64decode('${payloadB64}').decode())

${script}
`.trim();
    const sshArgs = [
      "-S",
      socketPath,
      `${sshConfig.username}@${sshConfig.host}`,
      `python3 -c ${this.shellQuote(wrappedScript)}`
    ];
    let stdout;
    try {
      const result = await this.execFileAsync("ssh", sshArgs, 1e4);
      stdout = result.stdout.trim();
    } catch (error) {
      throw new Error(`Remote workspace operation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`Remote workspace operation returned invalid JSON for ${projectId}`);
    }
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    return parsed.data;
  }
  async listBranches(socketPath, request) {
    return this.runRemote(
      socketPath,
      request.projectId,
      request.sshConfig,
      { projectDir: request.projectDir },
      `
import subprocess

try:
    repo_root = subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=payload['projectDir'],
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.strip()
    branches = subprocess.run(
        ['git', 'branch', '--format=%(refname:short)'],
        cwd=repo_root,
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.splitlines()
    print(json.dumps({'ok': True, 'data': [b for b in branches if b]}))
except Exception as err:
    print(json.dumps({'ok': False, 'error': str(err)}))
`
    );
  }
  async create(socketPath, request) {
    return this.runRemote(
      socketPath,
      request.projectId,
      request.sshConfig,
      {
        projectDir: request.projectDir,
        name: request.name,
        baseBranch: request.baseBranch
      },
      `
import os, subprocess

try:
    repo_root = subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=payload['projectDir'],
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.strip()
    try:
        subprocess.run(
            ['git', 'check-ref-format', '--branch', payload['name']],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
            check=True
        )
    except Exception:
        raise RuntimeError(f'Invalid branch name: "{payload["name"]}"')

    worktree_path = os.path.join(repo_root, '.worktrees', payload['name'])
    try:
        subprocess.run(
            ['git', 'worktree', 'add', worktree_path, '-b', payload['name'], payload['baseBranch']],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
            check=True
        )
    except subprocess.CalledProcessError as err:
        msg = err.stderr.strip() or err.stdout.strip() or str(err)
        if 'already exists' in msg:
            raise RuntimeError(f'Branch "{payload["name"]}" already exists')
        raise RuntimeError(f'Failed to create workspace: {msg}')

    relative_project_path = os.path.relpath(os.path.realpath(payload['projectDir']), os.path.realpath(repo_root))
    if relative_project_path == '.':
        relative_project_path = ''

    print(json.dumps({
        'ok': True,
        'data': {
            'worktreePath': worktree_path,
            'branchName': payload['name'],
            'relativeProjectPath': relative_project_path
        }
    }))
except Exception as err:
    print(json.dumps({'ok': False, 'error': str(err)}))
`
    );
  }
  async delete(socketPath, request) {
    return this.runRemote(
      socketPath,
      request.projectId,
      request.sshConfig,
      {
        projectDir: request.projectDir,
        worktreePath: request.worktreePath,
        branchName: request.branchName,
        baseBranch: request.baseBranch,
        force: !!request.force,
        keepBranch: !!request.keepBranch
      },
      `
import os, shutil, subprocess

try:
    repo_root = subprocess.run(
        ['git', 'rev-parse', '--show-toplevel'],
        cwd=payload['projectDir'],
        capture_output=True,
        text=True,
        timeout=5,
        check=True
    ).stdout.strip()

    if not payload.get('force'):
        has_uncommitted = False
        try:
            status_stdout = subprocess.run(
                ['git', '-C', payload['worktreePath'], 'status', '--porcelain'],
                capture_output=True,
                text=True,
                timeout=5,
                check=True
            ).stdout.strip()
            has_uncommitted = len(status_stdout) > 0
        except Exception:
            has_uncommitted = False

        is_unmerged = False
        try:
            merged_stdout = subprocess.run(
                ['git', '-C', repo_root, 'branch', '--merged', payload['baseBranch']],
                capture_output=True,
                text=True,
                timeout=5,
                check=True
            ).stdout
            merged_branches = [line.strip().lstrip('*+ ').strip() for line in merged_stdout.splitlines()]
            is_unmerged = payload['branchName'] not in merged_branches
        except Exception:
            is_unmerged = False

        if has_uncommitted and is_unmerged:
            print(json.dumps({'ok': True, 'data': {'status': 'uncommitted-and-unmerged', 'baseBranch': payload['baseBranch']}}))
            raise SystemExit(0)
        if has_uncommitted:
            print(json.dumps({'ok': True, 'data': {'status': 'uncommitted'}}))
            raise SystemExit(0)
        if is_unmerged:
            print(json.dumps({'ok': True, 'data': {'status': 'unmerged', 'baseBranch': payload['baseBranch']}}))
            raise SystemExit(0)

    try:
        subprocess.run(
            ['git', '-C', repo_root, 'worktree', 'remove', '--force', payload['worktreePath']],
            capture_output=True,
            text=True,
            timeout=10,
            check=True
        )
    except Exception:
        if os.path.exists(payload['worktreePath']):
            shutil.rmtree(payload['worktreePath'], ignore_errors=True)
        subprocess.run(
            ['git', '-C', repo_root, 'worktree', 'prune'],
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )

    if not payload.get('keepBranch'):
        subprocess.run(
            ['git', '-C', repo_root, 'branch', '-D', payload['branchName']],
            capture_output=True,
            text=True,
            timeout=5,
            check=False
        )

    print(json.dumps({'ok': True, 'data': {'status': 'ok'}}))
except SystemExit:
    raise
except Exception as err:
    print(json.dumps({'ok': False, 'error': str(err)}))
`
    );
  }
}
const execFileAsync$1 = util.promisify(child_process.execFile);
class WorkspaceManager {
  async getRepoRoot(projectDir) {
    const { stdout } = await execFileAsync$1("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, timeout: 5e3 });
    return fs.realpathSync(stdout.trim());
  }
  async listBranches(projectDir) {
    const repoRoot = await this.getRepoRoot(projectDir);
    const { stdout } = await execFileAsync$1("git", ["branch", "--format=%(refname:short)"], { cwd: repoRoot, timeout: 5e3 });
    return stdout.trim().split("\n").filter(Boolean);
  }
  async create(projectDir, name, baseBranch) {
    const repoRoot = await this.getRepoRoot(projectDir);
    try {
      await execFileAsync$1("git", ["check-ref-format", "--branch", name], { cwd: repoRoot, timeout: 5e3 });
    } catch {
      throw new Error(`Invalid branch name: "${name}"`);
    }
    const worktreePath = path.join(repoRoot, ".worktrees", name);
    try {
      await execFileAsync$1("git", ["worktree", "add", worktreePath, "-b", name, baseBranch], { cwd: repoRoot, timeout: 1e4 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists")) {
        throw new Error(`Branch "${name}" already exists`);
      }
      throw new Error(`Failed to create workspace: ${msg}`);
    }
    const rel = path.relative(repoRoot, fs.realpathSync(projectDir));
    return { worktreePath, branchName: name, relativeProjectPath: rel };
  }
  async delete(opts) {
    const repoRoot = await this.getRepoRoot(opts.projectDir);
    if (!opts.force) {
      let hasUncommitted = false;
      try {
        const { stdout } = await execFileAsync$1("git", ["-C", opts.worktreePath, "status", "--porcelain"], { timeout: 5e3 });
        hasUncommitted = stdout.trim().length > 0;
      } catch {
        hasUncommitted = false;
      }
      let isUnmerged = false;
      try {
        const { stdout } = await execFileAsync$1("git", ["-C", repoRoot, "branch", "--merged", opts.baseBranch], { timeout: 5e3 });
        const mergedBranches = stdout.split("\n").map((b) => b.trim().replace(/^[*+] /, ""));
        isUnmerged = !mergedBranches.includes(opts.branchName);
      } catch {
        isUnmerged = false;
      }
      if (hasUncommitted && isUnmerged) return { status: "uncommitted-and-unmerged", baseBranch: opts.baseBranch };
      if (hasUncommitted) return { status: "uncommitted" };
      if (isUnmerged) return { status: "unmerged", baseBranch: opts.baseBranch };
    }
    try {
      await execFileAsync$1("git", ["-C", repoRoot, "worktree", "remove", "--force", opts.worktreePath], { timeout: 1e4 });
    } catch {
      if (fs.existsSync(opts.worktreePath)) {
        fs.rmSync(opts.worktreePath, { recursive: true, force: true });
      }
      await execFileAsync$1("git", ["-C", repoRoot, "worktree", "prune"], { timeout: 5e3 });
    }
    if (!opts.keepBranch) {
      try {
        await execFileAsync$1("git", ["-C", repoRoot, "branch", "-D", opts.branchName], { timeout: 5e3 });
      } catch {
      }
    }
    return { status: "ok" };
  }
}
class NotesStorage {
  filePath;
  constructor(dir) {
    this.filePath = path.join(dir, "notes.json");
  }
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
const FILENAME = "palette-frecency.json";
const DEFAULT = { version: 1, entries: {} };
class PaletteFrecencyStorage {
  filePath;
  constructor(dir) {
    this.filePath = path.join(dir, FILENAME);
  }
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.entries !== "object") return DEFAULT;
      return parsed;
    } catch {
      return DEFAULT;
    }
  }
  save(file) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2), "utf-8");
  }
}
function parseNumstat(stdout) {
  const summary = { added: 0, deleted: 0 };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [addedText, deletedText] = line.split("	");
    const added = Number.parseInt(addedText, 10);
    const deleted = Number.parseInt(deletedText, 10);
    if (Number.isFinite(added)) {
      summary.added += added;
    }
    if (Number.isFinite(deleted)) {
      summary.deleted += deleted;
    }
  }
  return summary;
}
function piExtensionLocalPath() {
  const p = path.join(__dirname, "pi-status-extension.mjs");
  const packed = `app.asar${path.sep}`;
  return p.includes(packed) ? p.replace(packed, `app.asar.unpacked${path.sep}`) : p;
}
function piExtensionRemotePath(username) {
  return `/tmp/devtool-${username}/pi-status-extension.mjs`;
}
function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function buildRemotePiExtensionScript(remoteExtPath) {
  const b64 = fs.readFileSync(piExtensionLocalPath()).toString("base64");
  const dir = path.posix.dirname(remoteExtPath);
  return `mkdir -p ${shellQuote(dir)} && python3 -c "
import base64
open(${shellQuote(remoteExtPath)}, 'wb').write(base64.b64decode('${b64}'))
"`;
}
const execFileAsync = util.promisify(child_process.execFile);
const CONFIG_DIR = path.join(os.homedir(), ".devtool");
const MAX_SCROLLBACK_CHARS = 2e6;
const DEBUG_LOG_PATH = path.join(CONFIG_DIR, "debug.log");
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function trimScrollback(scrollback) {
  if (scrollback.length <= MAX_SCROLLBACK_CHARS) return scrollback;
  return scrollback.slice(-MAX_SCROLLBACK_CHARS);
}
async function hasHeadCommit(resolvedCwd) {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: resolvedCwd });
    return true;
  } catch {
    return false;
  }
}
async function readUntrackedSummary(resolvedCwd) {
  try {
    const { stdout } = await execFileAsync(
      "/bin/sh",
      ["-c", "git ls-files --others --exclude-standard -z | xargs -0 wc -l 2>/dev/null | tail -1"],
      { cwd: resolvedCwd, timeout: 5e3 }
    );
    const added = parseInt(stdout.trim(), 10) || 0;
    return { added, deleted: 0 };
  } catch {
    return { added: 0, deleted: 0 };
  }
}
async function readGitDiffSummary(resolvedCwd) {
  const untrackedSummary = await readUntrackedSummary(resolvedCwd);
  try {
    const diffArgs = await hasHeadCommit(resolvedCwd) ? ["diff", "--numstat", "HEAD", "--"] : ["diff", "--numstat", "--cached", "--"];
    const { stdout } = await execFileAsync("git", diffArgs, { cwd: resolvedCwd });
    const trackedSummary = parseNumstat(stdout);
    return {
      added: trackedSummary.added + untrackedSummary.added,
      deleted: trackedSummary.deleted + untrackedSummary.deleted
    };
  } catch {
    return untrackedSummary;
  }
}
function getWindowGeometry(window) {
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized()
  };
}
class AppRuntime {
  constructor(createWindow2) {
    this.createWindow = createWindow2;
    this.projectsData = this.storage.loadProjects();
    this.config = this.storage.loadConfig();
    this.startupWindowStates = this.storage.loadWindowSession(this.projectsData).windows;
  }
  storage = new Storage(CONFIG_DIR);
  scrollbackStorage = new ScrollbackStorage(path.join(CONFIG_DIR, "scrollback"));
  notesStorage = new NotesStorage(CONFIG_DIR);
  paletteFrecencyStorage = new PaletteFrecencyStorage(CONFIG_DIR);
  ptyManager = new PtyManager();
  hookServer = new HookServer();
  codexSessionManager = new CodexSessionManager();
  workspaceManager = new WorkspaceManager();
  remoteWorkspaceManager = new RemoteWorkspaceManager();
  windows = /* @__PURE__ */ new Map();
  windowStates = /* @__PURE__ */ new Map();
  ptyRuntimes = /* @__PURE__ */ new Map();
  hookInjector;
  sshManager;
  started = false;
  quitting = false;
  socksProxyEnabled = /* @__PURE__ */ new Map();
  socksProxyStarting = /* @__PURE__ */ new Map();
  projectsData;
  config;
  startupWindowStates;
  async start() {
    if (this.started) return;
    this.started = true;
    await this.hookServer.start();
    this.logDebug(`start hookPort=${this.hookServer.getPort()}`);
    this.hookInjector = new HookInjector(this.hookServer.getPort());
    this.sshManager = new SshConnectionManager(path.join(CONFIG_DIR, "ssh"), this.hookServer.getPort());
    this.registerEventForwarders();
    this.registerIpcHandlers();
  }
  registerWindow(window, initialViewState) {
    this.windows.set(window.id, window);
    this.windowStates.set(window.id, {
      geometry: getWindowGeometry(window),
      viewState: initialViewState ? cloneWindowViewState(initialViewState) : buildWindowViewState(this.projectsData.projects, this.config)
    });
    this.logDebug(`registerWindow windowId=${window.id}`);
    const syncGeometry = () => {
      this.updateWindowGeometry(window.id);
    };
    window.on("move", syncGeometry);
    window.on("resize", syncGeometry);
    window.on("maximize", syncGeometry);
    window.on("unmaximize", syncGeometry);
    window.on("closed", () => {
      this.logDebug(`windowClosed windowId=${window.id}`);
      this.windows.delete(window.id);
      if (!this.quitting) {
        this.windowStates.delete(window.id);
        this.persistWindowSession();
      }
      for (const [tabId, runtime] of this.ptyRuntimes.entries()) {
        runtime.attachedWindowIds.delete(window.id);
        if (runtime.controllerWindowId === window.id) {
          const nextController = runtime.attachedWindowIds.values().next().value ?? null;
          runtime.controllerWindowId = nextController;
          this.logDebug(`ptyControllerReassigned id=${tabId} windowId=${nextController ?? "none"}`);
        }
      }
    });
  }
  getStartupWindowStates() {
    return this.startupWindowStates.map((state) => clonePersistedWindowState(state));
  }
  prepareForQuit() {
    this.quitting = true;
  }
  async shutdown() {
    this.persistWindowSession();
    for (const [tabId, runtime] of this.ptyRuntimes.entries()) {
      this.scrollbackStorage.save(tabId, runtime.scrollback);
    }
    this.ptyManager.killAll();
    this.hookInjector.cleanupAll();
    await this.hookServer.stop();
    await this.sshManager.disconnectAll().catch(() => {
    });
  }
  registerEventForwarders() {
    this.hookServer.on("session-start", (tabId, body) => {
      this.broadcastToAttachedWindows(tabId, "hook-session-start", tabId, body);
    });
    this.hookServer.on("working", (tabId) => {
      this.broadcastToAttachedWindows(tabId, "hook-working", tabId);
    });
    this.hookServer.on("stopped", (tabId) => {
      this.broadcastToAttachedWindows(tabId, "hook-stopped", tabId);
    });
    this.hookServer.on("notification", (tabId, body) => {
      this.broadcastToAttachedWindows(tabId, "hook-notification", tabId, body);
    });
    this.sshManager.on("status-changed", async (projectId, status) => {
      this.logDebug(`sshStatus projectId=${projectId} status=${status}`);
      this.broadcastToAllWindows("ssh-status-changed", projectId, status);
      if (status === "disconnected" && this.socksProxyEnabled.get(projectId)) {
        const ses = electron.session.fromPartition(`persist:browser-${projectId}`);
        await ses.setProxy({ proxyRules: "direct://" }).catch(() => {
        });
        await ses.closeAllConnections().catch(() => {
        });
        this.broadcastToAllWindows("socks-proxy-status-changed", projectId, false);
      }
    });
    this.sshManager.on("tunnel-status-changed", (projectId, status, error) => {
      this.logDebug(`tunnelStatus projectId=${projectId} status=${status}${error ? ` error=${error}` : ""}`);
      this.broadcastToAllWindows("ssh-tunnel-status-changed", projectId, status, error);
    });
    this.sshManager.on("socks-proxy-status-changed", async (projectId, enabled) => {
      if (!enabled) {
        const ses = electron.session.fromPartition(`persist:browser-${projectId}`);
        await ses.setProxy({ proxyRules: "direct://" }).catch(() => {
        });
        await ses.closeAllConnections().catch(() => {
        });
        this.broadcastToAllWindows("socks-proxy-status-changed", projectId, false);
        const config = this.sshManager.getConfig(projectId);
        if (this.socksProxyEnabled.get(projectId) && config && this.sshManager.getStatus(projectId) === "connected") {
          try {
            const port = await this.sshManager.startSocksProxy(projectId, config);
            await ses.setProxy({
              proxyRules: `socks5://127.0.0.1:${port}`,
              proxyBypassRules: "<-loopback>"
            });
            await ses.closeAllConnections();
            this.broadcastToAllWindows("socks-proxy-status-changed", projectId, true, port);
          } catch {
          }
        }
      }
    });
    electron.nativeTheme.on("updated", () => {
      this.broadcastToAllWindows("theme-changed", electron.nativeTheme.shouldUseDarkColors ? "dark" : "light");
    });
  }
  async ensureSshConnected(projectId, sshConfig) {
    if (this.sshManager.getStatus(projectId) === "connected") return;
    await this.sshManager.connect(projectId, sshConfig);
    this.sshManager.startHealthChecks(projectId, sshConfig);
  }
  registerIpcHandlers() {
    electron.ipcMain.handle("load-projects", () => clone(this.projectsData));
    electron.ipcMain.handle("save-projects", (event, data) => {
      this.projectsData = Storage.normalizeProjectsData(data);
      this.storage.saveProjects(this.projectsData);
      this.broadcastToAllWindows("projects-updated", clone(this.projectsData));
      return void 0;
    });
    electron.ipcMain.handle("load-config", () => clone(this.config));
    electron.ipcMain.handle("save-config", (_event, config) => {
      this.config = { ...this.config, ...config };
      this.storage.saveConfig(this.config);
      this.broadcastToAllWindows("config-updated", clone(this.config));
      return void 0;
    });
    electron.ipcMain.handle("load-window-state", (event) => {
      const window = electron.BrowserWindow.fromWebContents(event.sender);
      const state = window ? this.windowStates.get(window.id) ?? null : null;
      return state ? cloneWindowViewState(state.viewState) : buildWindowViewState(this.projectsData.projects, this.config);
    });
    electron.ipcMain.handle("save-window-state", (event, viewState) => {
      const window = electron.BrowserWindow.fromWebContents(event.sender);
      if (!window) return void 0;
      const current = this.windowStates.get(window.id);
      this.windowStates.set(window.id, {
        geometry: current ? cloneWindowGeometry(current.geometry) : getWindowGeometry(window),
        viewState: cloneWindowViewState(viewState)
      });
      this.persistWindowSession();
      return void 0;
    });
    electron.ipcMain.handle("open-window", (_event, viewState) => {
      this.logDebug(`openWindow seeded=${viewState ? "yes" : "no"}`);
      this.createWindow(viewState ?? null, null);
    });
    electron.ipcMain.handle("pick-directory", async (event) => {
      const owner = electron.BrowserWindow.fromWebContents(event.sender) ?? void 0;
      const result = await electron.dialog.showOpenDialog(owner, {
        properties: ["openDirectory"]
      });
      return result.canceled ? null : result.filePaths[0];
    });
    electron.ipcMain.handle("pick-file", async (event, title) => {
      const owner = electron.BrowserWindow.fromWebContents(event.sender) ?? void 0;
      const result = await electron.dialog.showOpenDialog(owner, {
        title: title || "Select file",
        properties: ["openFile", "showHiddenFiles"]
      });
      return result.canceled ? null : result.filePaths[0];
    });
    electron.ipcMain.handle("get-native-theme", () => electron.nativeTheme.shouldUseDarkColors ? "dark" : "light");
    electron.ipcMain.handle("clipboard-write-text", (_event, text) => {
      electron.clipboard.writeText(text);
      return void 0;
    });
    electron.ipcMain.handle("open-external", async (_event, url) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Invalid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http and https URLs are allowed");
      }
      await electron.shell.openExternal(parsed.toString());
    });
    electron.ipcMain.handle("app:open-devtools", (event) => {
      electron.BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools();
    });
    electron.ipcMain.handle("app:quit", () => electron.app.quit());
    electron.ipcMain.handle("scrollback-save", (_event, tabId, data) => {
      const scrollback = trimScrollback(data);
      this.scrollbackStorage.save(tabId, scrollback);
      const runtime = this.ptyRuntimes.get(tabId);
      if (runtime) runtime.scrollback = scrollback;
      return void 0;
    });
    electron.ipcMain.handle("scrollback-load", (_event, tabId) => {
      const runtime = this.ptyRuntimes.get(tabId);
      return runtime ? runtime.scrollback : this.scrollbackStorage.load(tabId);
    });
    electron.ipcMain.handle("scrollback-delete", (_event, tabId) => {
      this.scrollbackStorage.delete(tabId);
      return void 0;
    });
    electron.ipcMain.on("scrollback-save-sync", (event, tabId, data) => {
      const scrollback = trimScrollback(data);
      this.scrollbackStorage.save(tabId, scrollback);
      const runtime = this.ptyRuntimes.get(tabId);
      if (runtime) runtime.scrollback = scrollback;
      event.returnValue = true;
    });
    electron.ipcMain.handle("notes-load", () => this.notesStorage.load());
    electron.ipcMain.handle("notes-save", (_event, data) => this.notesStorage.save(data));
    electron.ipcMain.handle("palette-frecency:load", () => this.paletteFrecencyStorage.load());
    electron.ipcMain.handle("palette-frecency:save", (_event, file) => this.paletteFrecencyStorage.save(file));
    electron.ipcMain.handle("ssh-connect", async (_event, projectId, sshConfig) => {
      await this.sshManager.connect(projectId, sshConfig);
      this.sshManager.startHealthChecks(projectId, sshConfig);
      const tunnel = this.getProjectTunnel(projectId);
      if (tunnel) {
        try {
          await this.sshManager.setTunnel(projectId, sshConfig, tunnel);
        } catch {
        }
      }
      if (this.socksProxyEnabled.get(projectId)) {
        try {
          const port = await this.sshManager.startSocksProxy(projectId, sshConfig);
          const ses = electron.session.fromPartition(`persist:browser-${projectId}`);
          await ses.setProxy({
            proxyRules: `socks5://127.0.0.1:${port}`,
            proxyBypassRules: "<-loopback>"
          });
          await ses.closeAllConnections();
          this.broadcastToAllWindows("socks-proxy-status-changed", projectId, true, port);
        } catch {
        }
      }
    });
    electron.ipcMain.handle("ssh-disconnect", async (_event, projectId, sshConfig) => {
      if (this.socksProxyEnabled.get(projectId)) {
        const ses = electron.session.fromPartition(`persist:browser-${projectId}`);
        await ses.setProxy({ proxyRules: "direct://" }).catch(() => {
        });
        await ses.closeAllConnections().catch(() => {
        });
        this.broadcastToAllWindows("socks-proxy-status-changed", projectId, false);
      }
      await this.sshManager.disconnect(projectId, sshConfig);
    });
    electron.ipcMain.handle("ssh-status", (_event, projectId) => {
      return this.sshManager.getStatus(projectId);
    });
    electron.ipcMain.handle("ssh-set-tunnel", async (_event, projectId, sshConfig, tunnel) => {
      await this.sshManager.setTunnel(projectId, sshConfig, tunnel);
    });
    electron.ipcMain.handle("ssh-tunnel-status", (_event, projectId) => {
      return clone(this.sshManager.getTunnelState(projectId));
    });
    electron.ipcMain.handle("socks-proxy-enable", async (_event, projectId, sshConfig) => {
      this.logDebug(`socksProxyEnable projectId=${projectId} sshStatus=${this.sshManager.getStatus(projectId)}`);
      this.socksProxyEnabled.set(projectId, true);
      const pending = this.socksProxyStarting.get(projectId);
      if (pending) {
        const port = await pending;
        return { port };
      }
      const startPromise = (async () => {
        this.logDebug(`socksProxyEnable starting proxy for ${projectId}`);
        const port = await this.sshManager.startSocksProxy(projectId, sshConfig);
        this.logDebug(`socksProxyEnable proxy started on port ${port}`);
        if (!this.socksProxyEnabled.get(projectId)) {
          await this.sshManager.stopSocksProxy(projectId);
          throw new Error("SOCKS proxy was disabled during startup");
        }
        const ses = electron.session.fromPartition(`persist:browser-${projectId}`);
        await ses.setProxy({
          proxyRules: `socks5://127.0.0.1:${port}`,
          proxyBypassRules: "<-loopback>"
        });
        await ses.closeAllConnections();
        this.logDebug(`socksProxyEnable session configured for ${projectId} port=${port}`);
        this.broadcastToAllWindows("socks-proxy-status-changed", projectId, true, port);
        return port;
      })();
      this.socksProxyStarting.set(projectId, startPromise);
      try {
        const port = await startPromise;
        this.logDebug(`socksProxyEnable success projectId=${projectId} port=${port}`);
        return { port };
      } catch (err) {
        this.logDebug(`socksProxyEnable FAILED projectId=${projectId} error=${err instanceof Error ? err.message : String(err)}`);
        this.socksProxyEnabled.set(projectId, false);
        throw err;
      } finally {
        this.socksProxyStarting.delete(projectId);
      }
    });
    electron.ipcMain.handle("socks-proxy-disable", async (_event, projectId) => {
      this.socksProxyEnabled.set(projectId, false);
      await this.sshManager.stopSocksProxy(projectId);
      const ses = electron.session.fromPartition(`persist:browser-${projectId}`);
      await ses.setProxy({ proxyRules: "direct://" });
      await ses.closeAllConnections();
      this.broadcastToAllWindows("socks-proxy-status-changed", projectId, false);
    });
    electron.ipcMain.handle("socks-proxy-status", (_event, projectId) => {
      const hasEntry = this.socksProxyEnabled.has(projectId);
      const enabled = hasEntry ? this.socksProxyEnabled.get(projectId) : void 0;
      const proxy = this.sshManager.getSocksProxy(projectId);
      this.logDebug(`socksProxyStatus projectId=${projectId} hasEntry=${hasEntry} enabled=${enabled} port=${proxy?.port}`);
      return { enabled, port: proxy?.port };
    });
    electron.ipcMain.handle("hooks-inject", (_event, projectDir) => {
      this.hookInjector.inject(projectDir);
    });
    electron.ipcMain.handle("hooks-cleanup", (_event, projectDir) => {
      this.hookInjector.cleanup(projectDir);
    });
    electron.ipcMain.handle("hooks-cleanup-remote", async (_event, projectId, sshConfig, remoteDir) => {
      const effectiveRemoteDir = remoteDir || sshConfig.remoteDir;
      const isLast = this.hookInjector.remoteCleanup(projectId, effectiveRemoteDir);
      if (!isLast) return;
      if (this.sshManager.getStatus(projectId) !== "connected") return;
      const cleanupScript = this.hookInjector.buildRemoteCleanupScript(effectiveRemoteDir);
      const cleanupArgs = [
        "-S",
        this.sshManager.getSocketPath(projectId),
        `${sshConfig.username}@${sshConfig.host}`,
        cleanupScript
      ];
      try {
        const { execFile: execFile2 } = await import("child_process");
        const { promisify: promisify2 } = await import("util");
        await promisify2(execFile2)("ssh", cleanupArgs, { timeout: 5e3 });
      } catch {
      }
    });
    electron.ipcMain.handle("codex-read-session", async (_event, cwd, afterTs, projectId, sshConfig) => {
      if (!sshConfig || !projectId) {
        return { sessionId: await this.codexSessionManager.readLatestSessionId(cwd, afterTs) };
      }
      if (this.sshManager.getStatus(projectId) !== "connected") {
        throw new Error("SSH connection not established");
      }
      const readScript = this.codexSessionManager.buildRemoteReadSessionScript(cwd, afterTs);
      const sshArgs = [
        "-S",
        this.sshManager.getSocketPath(projectId),
        `${sshConfig.username}@${sshConfig.host}`,
        readScript
      ];
      try {
        const { execFile: execFileCb } = await import("child_process");
        const { promisify: promisify2 } = await import("util");
        const { stdout } = await promisify2(execFileCb)("ssh", sshArgs, { timeout: 5e3 });
        return JSON.parse(stdout.trim());
      } catch (error) {
        throw new Error(`Failed to read Codex session: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    electron.ipcMain.handle(
      "pty-spawn",
      async (event, id, shell2, cwd, cols, rows, args, extraEnv, projectId, sshConfig) => {
        const window = electron.BrowserWindow.fromWebContents(event.sender);
        if (!window) {
          throw new Error("Unable to resolve window for PTY attach");
        }
        const resolvedShell = shell2 || process.env.SHELL || "/bin/sh";
        this.logDebug(`ptySpawnRequest windowId=${window.id} id=${id} shell=${resolvedShell} cwd=${cwd} cols=${cols} rows=${rows}`);
        return this.attachOrCreatePty(window.id, id, resolvedShell, cwd, cols, rows, args, extraEnv, projectId, sshConfig);
      }
    );
    electron.ipcMain.on("pty-write", (event, id, data) => {
      const window = electron.BrowserWindow.fromWebContents(event.sender);
      const runtime = this.ptyRuntimes.get(id);
      if (!window || !runtime || !runtime.attachedWindowIds.has(window.id)) return;
      this.claimPtyControl(id, window.id);
      this.ptyManager.write(id, data);
    });
    electron.ipcMain.on("pty-resize", (event, id, cols, rows) => {
      const window = electron.BrowserWindow.fromWebContents(event.sender);
      const runtime = this.ptyRuntimes.get(id);
      if (!window || !runtime || !runtime.attachedWindowIds.has(window.id)) return;
      if (!window.isFocused() && runtime.controllerWindowId !== window.id) {
        this.logDebug(`ptyResizeIgnored id=${id} windowId=${window.id} cols=${cols} rows=${rows}`);
        return;
      }
      this.claimPtyControl(id, window.id);
      runtime.cols = cols;
      runtime.rows = rows;
      this.broadcastToAttachedWindows(id, "pty-size-sync", id, cols, rows);
      this.ptyManager.resize(id, cols, rows);
    });
    electron.ipcMain.on("pty-kill", (_event, id) => {
      this.killPty(id);
    });
    electron.ipcMain.handle("workspace-list-branches", async (_event, request) => {
      if (request.sshConfig && request.projectId) {
        await this.ensureSshConnected(request.projectId, request.sshConfig);
        return this.remoteWorkspaceManager.listBranches(this.sshManager.getSocketPath(request.projectId), {
          ...request,
          projectId: request.projectId,
          sshConfig: request.sshConfig
        });
      }
      return this.workspaceManager.listBranches(request.projectDir);
    });
    electron.ipcMain.handle("workspace-create", async (_event, request) => {
      const result = request.sshConfig && request.projectId ? await (async () => {
        await this.ensureSshConnected(request.projectId, request.sshConfig);
        return this.remoteWorkspaceManager.create(this.sshManager.getSocketPath(request.projectId), {
          ...request,
          projectId: request.projectId,
          sshConfig: request.sshConfig
        });
      })() : await this.workspaceManager.create(request.projectDir, request.name, request.baseBranch);
      return { ...result, baseBranch: request.baseBranch };
    });
    electron.ipcMain.handle(
      "workspace-delete",
      async (_event, request) => {
        if (request.sshConfig && request.projectId) {
          await this.ensureSshConnected(request.projectId, request.sshConfig);
          return this.remoteWorkspaceManager.delete(this.sshManager.getSocketPath(request.projectId), {
            ...request,
            projectId: request.projectId,
            sshConfig: request.sshConfig
          });
        }
        return this.workspaceManager.delete(request);
      }
    );
    const validatePath = (projectCwd, relativePath) => {
      const resolved = path.resolve(projectCwd, relativePath);
      if (!resolved.startsWith(path.resolve(projectCwd) + path.sep) && resolved !== path.resolve(projectCwd)) {
        throw new Error("Path traversal not allowed");
      }
      return resolved;
    };
    electron.ipcMain.handle("fb-read-directory", async (_event, projectCwd, relativeDirPath) => {
      const fullPath = validatePath(projectCwd, relativeDirPath);
      const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
      return entries.filter((entry) => !entry.name.startsWith(".")).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        relativePath: path.join(relativeDirPath, entry.name)
      })).sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    });
    electron.ipcMain.handle("fb-read-file", async (_event, projectCwd, relativeFilePath) => {
      const fullPath = validatePath(projectCwd, relativeFilePath);
      return fsPromises.readFile(fullPath, "utf-8");
    });
    electron.ipcMain.handle("fb-write-file", async (_event, projectCwd, relativeFilePath, content) => {
      const fullPath = validatePath(projectCwd, relativeFilePath);
      await fsPromises.writeFile(fullPath, content, "utf-8");
    });
    electron.ipcMain.handle("git-project-posture", async (_event, projectCwd) => {
      const resolvedCwd = path.resolve(projectCwd);
      const empty = {
        isGitRepo: false,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        dirtyCount: 0,
        lastCommit: null
      };
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["status", "--porcelain=v2", "--branch"],
          { cwd: resolvedCwd }
        );
        let branch = null;
        let upstream = null;
        let ahead = 0;
        let behind = 0;
        let dirtyCount = 0;
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
          else if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length).trim();
          else if (line.startsWith("# branch.ab ")) {
            const m = line.match(/\+(\d+)\s+-(\d+)/);
            if (m) {
              ahead = Number(m[1]);
              behind = Number(m[2]);
            }
          } else if (!line.startsWith("#")) {
            dirtyCount += 1;
          }
        }
        let lastCommit = null;
        try {
          const { stdout: logOut } = await execFileAsync(
            "git",
            ["log", "-1", "--format=%H%x00%s%x00%an%x00%cI"],
            { cwd: resolvedCwd }
          );
          const trimmed = logOut.replace(/\n+$/, "");
          if (trimmed) {
            const [sha, subject, author, isoDate] = trimmed.split("\0");
            if (sha) lastCommit = { sha, subject: subject ?? "", author: author ?? "", isoDate: isoDate ?? "" };
          }
        } catch {
        }
        return { isGitRepo: true, branch, upstream, ahead, behind, dirtyCount, lastCommit };
      } catch {
        return empty;
      }
    });
    electron.ipcMain.handle("git-commit-history", async (_event, projectCwd) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["log", "--format=%cI"],
          { cwd: resolvedCwd, maxBuffer: 32 * 1024 * 1024 }
        );
        const commits = stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
        return { commits };
      } catch {
        return { commits: [] };
      }
    });
    electron.ipcMain.handle("fb-git-status", async (_event, projectCwd) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        const [{ stdout }, summary] = await Promise.all([
          execFileAsync("git", ["status", "--porcelain"], { cwd: resolvedCwd }),
          readGitDiffSummary(resolvedCwd)
        ]);
        const staged = [];
        const unstaged = [];
        const untracked = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const indexStatus = line[0];
          const workTreeStatus = line[1];
          const filePath = line.slice(3).trim();
          if (indexStatus === "?" && workTreeStatus === "?") {
            untracked.push({ relativePath: filePath, status: "?" });
          } else {
            if (indexStatus && indexStatus !== " " && indexStatus !== "?") {
              staged.push({ relativePath: filePath, status: indexStatus });
            }
            if (workTreeStatus && workTreeStatus !== " " && workTreeStatus !== "?") {
              unstaged.push({ relativePath: filePath, status: workTreeStatus });
            }
          }
        }
        return { staged, unstaged, untracked, summary };
      } catch {
        return {
          staged: [],
          unstaged: [],
          untracked: [],
          summary: { added: 0, deleted: 0 }
        };
      }
    });
    electron.ipcMain.handle("fb-git-diff", async (_event, projectCwd, relativeFilePath) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        const { stdout } = await execFileAsync("git", ["show", `HEAD:${relativeFilePath}`], { cwd: resolvedCwd });
        return stdout;
      } catch {
        return "";
      }
    });
    electron.ipcMain.handle("fb-git-stage", async (_event, projectCwd, files) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        await execFileAsync("git", ["add", "--", ...files], { cwd: resolvedCwd, timeout: 1e4 });
        return { success: true, message: `Staged ${files.length} file(s)` };
      } catch (err) {
        const stderr = err?.stderr?.trim();
        const msg = stderr || (err instanceof Error ? err.message : String(err));
        return { success: false, message: msg };
      }
    });
    electron.ipcMain.handle("fb-git-unstage", async (_event, projectCwd, files) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        await execFileAsync("git", ["reset", "HEAD", "--", ...files], { cwd: resolvedCwd, timeout: 1e4 });
        return { success: true, message: `Unstaged ${files.length} file(s)` };
      } catch (err) {
        const stderr = err?.stderr?.trim();
        const msg = stderr || (err instanceof Error ? err.message : String(err));
        return { success: false, message: msg };
      }
    });
    electron.ipcMain.handle("fb-git-discard", async (_event, projectCwd, files) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        await execFileAsync("git", ["checkout", "--", ...files], { cwd: resolvedCwd, timeout: 1e4 });
        return { success: true, message: `Discarded changes in ${files.length} file(s)` };
      } catch (err) {
        const stderr = err?.stderr?.trim();
        const msg = stderr || (err instanceof Error ? err.message : String(err));
        return { success: false, message: msg };
      }
    });
    electron.ipcMain.handle("fb-git-pull", async (_event, projectCwd) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        const { stdout, stderr } = await execFileAsync("git", ["pull"], { cwd: resolvedCwd, timeout: 6e4 });
        return { success: true, message: stdout.trim() || stderr.trim() || "Pull complete" };
      } catch (err) {
        const stderr = err?.stderr?.trim();
        const msg = stderr || (err instanceof Error ? err.message : String(err));
        return { success: false, message: msg };
      }
    });
    electron.ipcMain.handle("fb-git-commit", async (_event, projectCwd, commitMessage) => {
      const resolvedCwd = path.resolve(projectCwd);
      if (!commitMessage || !commitMessage.trim()) {
        return { success: false, message: "Commit message cannot be empty" };
      }
      try {
        const { stdout } = await execFileAsync("git", ["commit", "-m", commitMessage.trim()], { cwd: resolvedCwd, timeout: 3e4 });
        return { success: true, message: stdout.trim() || "Committed" };
      } catch (err) {
        const stderr = err?.stderr?.trim();
        const msg = stderr || (err instanceof Error ? err.message : String(err));
        return { success: false, message: msg };
      }
    });
    electron.ipcMain.handle("fb-git-push", async (_event, projectCwd) => {
      const resolvedCwd = path.resolve(projectCwd);
      try {
        const { stdout, stderr } = await execFileAsync("git", ["push"], { cwd: resolvedCwd, timeout: 6e4 });
        return { success: true, message: stdout.trim() || stderr.trim() || "Push complete" };
      } catch (err) {
        const stderr = err?.stderr?.trim();
        const msg = stderr || (err instanceof Error ? err.message : String(err));
        return { success: false, message: msg };
      }
    });
  }
  async attachOrCreatePty(windowId, id, shell2, cwd, cols, rows, args, extraEnv, projectId, sshConfig) {
    let runtime = this.ptyRuntimes.get(id);
    if (runtime && runtime.exitCode !== null && sshConfig && projectId && this.sshManager.getStatus(projectId) === "connected") {
      this.logDebug(`ptyAttach refresh-dead id=${id} exitCode=${runtime.exitCode}`);
      this.ptyManager.kill(id);
      this.scrollbackStorage.delete(id);
      this.ptyRuntimes.delete(id);
      runtime = void 0;
    }
    if (!runtime) {
      this.logDebug(`ptyAttach create windowId=${windowId} id=${id}`);
      runtime = {
        attachedWindowIds: /* @__PURE__ */ new Set(),
        controllerWindowId: windowId,
        cols,
        rows,
        scrollback: this.scrollbackStorage.load(id) ?? "",
        exitCode: null
      };
      this.ptyRuntimes.set(id, runtime);
      runtime.attachedWindowIds.add(windowId);
      this.spawnPty(id, shell2, cwd, cols, rows, args, extraEnv, projectId, sshConfig);
    } else {
      this.logDebug(`ptyAttach reuse windowId=${windowId} id=${id} scrollback=${runtime.scrollback.length} exit=${runtime.exitCode}`);
      runtime.attachedWindowIds.add(windowId);
    }
    return {
      cols: runtime.cols,
      rows: runtime.rows,
      scrollback: runtime.scrollback,
      exitCode: runtime.exitCode
    };
  }
  spawnPty(id, shell2, cwd, cols, rows, args, extraEnv, projectId, sshConfig) {
    this.logDebug(`ptySpawn start id=${id} shell=${shell2} cwd=${cwd}`);
    const expectedRuntime = this.ptyRuntimes.get(id);
    const callbacks = {
      onData: (data) => {
        const runtime = this.ptyRuntimes.get(id);
        if (!runtime || runtime !== expectedRuntime) return;
        runtime.scrollback = trimScrollback(runtime.scrollback + data);
        this.broadcastToAttachedWindows(id, "pty-data", id, data);
        if (sshConfig && projectId && /Shared connection to \S+ closed/.test(data)) {
          this.sshManager.triggerReconnect(projectId, sshConfig);
        }
      },
      onExit: (exitCode) => {
        const runtime = this.ptyRuntimes.get(id);
        if (!runtime || runtime !== expectedRuntime) return;
        runtime.exitCode = exitCode;
        this.logDebug(`ptyExit id=${id} exitCode=${exitCode}`);
        this.broadcastToAttachedWindows(id, "pty-exit", id, exitCode);
      }
    };
    if (sshConfig && projectId) {
      if (this.sshManager.getStatus(projectId) !== "connected") {
        throw new Error("SSH connection not established");
      }
      const remoteCwd = cwd || sshConfig.remoteDir;
      const isClaudeRemote = shell2 === "claude" && extraEnv?.DEVTOOL_TAB_ID;
      const isPiRemote = shell2 === AI_TAB_META.pi.command && extraEnv?.DEVTOOL_TAB_ID;
      let hookInjectPrefix = "";
      let remoteArgs = args;
      let remoteEnv = extraEnv;
      if (isClaudeRemote) {
        const remotePort = this.sshManager.getRemotePort(projectId);
        if (remotePort) {
          this.hookInjector.remoteInject(projectId, remoteCwd);
          hookInjectPrefix = this.hookInjector.buildRemoteInjectScript(remoteCwd, remotePort) + " && ";
        }
      } else if (isPiRemote) {
        const remotePort = this.sshManager.getRemotePort(projectId);
        if (remotePort) {
          const remoteExtPath = piExtensionRemotePath(sshConfig.username);
          hookInjectPrefix = buildRemotePiExtensionScript(remoteExtPath) + " && ";
          remoteArgs = [...args ?? [], "-e", remoteExtPath];
          remoteEnv = { ...extraEnv, DEVTOOL_HOOK_PORT: String(remotePort) };
        }
      }
      const sshArgs = this.sshManager.buildSpawnArgs(projectId, sshConfig, shell2, remoteArgs, remoteEnv, hookInjectPrefix, remoteCwd);
      this.ptyManager.spawn(id, "ssh", os.tmpdir(), cols, rows, sshArgs, void 0, callbacks);
    } else {
      const isClaudeLocal = shell2 === "claude" && extraEnv?.DEVTOOL_TAB_ID;
      const isPiLocal = shell2 === AI_TAB_META.pi.command && extraEnv?.DEVTOOL_TAB_ID;
      if (isClaudeLocal) {
        this.hookInjector.inject(cwd);
      }
      let localArgs = args;
      let localEnv = extraEnv;
      if (isPiLocal) {
        localArgs = [...args ?? [], "-e", piExtensionLocalPath()];
        localEnv = { ...extraEnv, DEVTOOL_HOOK_PORT: String(this.hookServer.getPort()) };
      }
      this.ptyManager.spawn(id, shell2, cwd, cols, rows, localArgs, localEnv, callbacks);
    }
  }
  killPty(id) {
    this.logDebug(`ptyKill id=${id}`);
    const runtime = this.ptyRuntimes.get(id);
    if (runtime) {
      this.scrollbackStorage.save(id, runtime.scrollback);
    }
    this.ptyManager.kill(id);
    this.ptyRuntimes.delete(id);
  }
  claimPtyControl(tabId, windowId) {
    const runtime = this.ptyRuntimes.get(tabId);
    if (!runtime) return;
    if (runtime.controllerWindowId !== windowId) {
      runtime.controllerWindowId = windowId;
      this.logDebug(`ptyController id=${tabId} windowId=${windowId}`);
    }
  }
  updateWindowGeometry(windowId) {
    const window = this.windows.get(windowId);
    const current = this.windowStates.get(windowId);
    if (!window || window.isDestroyed() || !current) return;
    this.windowStates.set(windowId, {
      geometry: getWindowGeometry(window),
      viewState: cloneWindowViewState(current.viewState)
    });
  }
  persistWindowSession() {
    this.storage.saveWindowSession({
      windows: Array.from(this.windowStates.values()).map((state) => clonePersistedWindowState(state))
    });
  }
  logDebug(message) {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.appendFileSync(DEBUG_LOG_PATH, `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`);
    } catch {
    }
  }
  broadcastToAllWindows(channel, ...args) {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, ...args);
      }
    }
  }
  getProjectTunnel(projectId) {
    return this.projectsData.projects.find((project) => project.id === projectId)?.tunnel;
  }
  broadcastToAttachedWindows(tabId, channel, ...args) {
    const runtime = this.ptyRuntimes.get(tabId);
    if (!runtime) return;
    for (const windowId of runtime.attachedWindowIds) {
      const window = this.windows.get(windowId);
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, ...args);
      }
    }
  }
}
if (process.env.DEVTOOL_CDP_PORT) {
  electron.app.commandLine.appendSwitch("remote-debugging-port", process.env.DEVTOOL_CDP_PORT);
}
let appRuntime = null;
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const sendToRenderer = (channel) => {
    const win = electron.BrowserWindow.getFocusedWindow();
    if (win) win.webContents.send(channel);
  };
  const template = [
    ...isMac ? [
      {
        label: electron.app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings...",
            accelerator: "Cmd+,",
            click: () => sendToRenderer("menu-open-settings")
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" }
        ]
      }
    ] : [],
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => sendToRenderer("menu-new-window")
        },
        {
          label: "New Terminal Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => sendToRenderer("menu-new-terminal")
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => sendToRenderer("menu-close-tab")
        },
        {
          label: "Reopen Closed Tab",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => sendToRenderer("menu-reopen-closed-tab")
        },
        {
          label: "Project Switcher",
          accelerator: "CmdOrCtrl+P",
          click: () => sendToRenderer("menu-project-switcher")
        },
        { type: "separator" },
        isMac ? { role: "close", accelerator: "" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => sendToRenderer("menu-toggle-sidebar")
        },
        {
          label: "Toggle File Browser",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => sendToRenderer("menu-toggle-file-browser")
        },
        { type: "separator" },
        {
          label: "Reload Tab",
          accelerator: "CmdOrCtrl+R",
          click: () => sendToRenderer("menu-reload-tab")
        },
        { type: "separator" },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+=",
          click: () => sendToRenderer("menu-zoom-in")
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: () => sendToRenderer("menu-zoom-out")
        },
        {
          label: "Reset Zoom",
          accelerator: "CmdOrCtrl+0",
          click: () => sendToRenderer("menu-zoom-reset")
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools", accelerator: "CmdOrCtrl+Alt+I" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...isMac ? [{ type: "separator" }, { role: "front" }] : []
      ]
    }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function createWindow(initialViewState, geometry) {
  const mainWindow = new electron.BrowserWindow({
    x: geometry?.x,
    y: geometry?.y,
    width: geometry?.width ?? 1200,
    height: geometry?.height ?? 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      webviewTag: true
    }
  });
  appRuntime?.registerWindow(mainWindow, initialViewState ?? null);
  if (geometry?.isMaximized) {
    mainWindow.maximize();
  }
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[renderer-load-failed] code=${errorCode} mainFrame=${isMainFrame} url=${validatedURL} error=${errorDescription}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer-process-gone] reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload-error] path=${preloadPath}`, error);
  });
  if (process.platform === "linux") {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || !input.control) return;
      const send = (channel) => {
        mainWindow.webContents.send(channel);
        event.preventDefault();
      };
      const key = input.key.toLowerCase();
      if (input.shift) {
        if (key === "n") send("menu-new-window");
        else if (key === "t") send("menu-reopen-closed-tab");
        else if (key === "e") send("menu-toggle-file-browser");
        else if (key === "v") {
          mainWindow.webContents.paste();
          event.preventDefault();
        } else if (key === "c") {
          mainWindow.webContents.copy();
          event.preventDefault();
        }
      } else if (input.alt) {
        if (key === "i") {
          mainWindow.webContents.toggleDevTools();
          event.preventDefault();
        }
      } else {
        if (key === "t") send("menu-new-terminal");
        else if (key === "w") send("menu-close-tab");
        else if (key === "p") send("menu-project-switcher");
        else if (key === "b") send("menu-toggle-sidebar");
        else if (key === "r") send("menu-reload-tab");
        else if (key === "=") send("menu-zoom-in");
        else if (key === "-") send("menu-zoom-out");
        else if (key === "0") send("menu-zoom-reset");
        else if (key === "q") {
          electron.app.quit();
        }
      }
    });
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return mainWindow;
}
electron.app.whenReady().then(async () => {
  await resolveShellEnv();
  if (process.platform === "darwin") {
    void electron.systemPreferences.askForMediaAccess("microphone").catch(() => {
    });
  }
  appRuntime = new AppRuntime((initialViewState, geometry) => createWindow(initialViewState, geometry));
  await appRuntime.start();
  buildAppMenu();
  const startupWindows = appRuntime.getStartupWindowStates();
  if (startupWindows.length > 0) {
    for (const state of startupWindows) {
      createWindow(state.viewState, state.geometry);
    }
  } else {
    createWindow();
  }
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", () => {
  appRuntime?.prepareForQuit();
  void appRuntime?.shutdown();
});
