// src/state.js
// ─────────────────────────────────────────────
// Persistent user state storage using state.json
// Prevents state loss when the bot restarts.
// ─────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(__dirname, '..', 'state.json');

function loadState() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}

function saveState(obj) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {}
}

module.exports = {
  /**
   * Simple State Methods
   */
  get: (userId) => loadState()[String(userId)],
  set: (userId, value) => {
    const state = loadState();
    state[String(userId)] = value;
    saveState(state);
  },
  delete: (userId) => {
    // We rely on the global scavenger in bot.js to cleanup files
    // This allows files to persist briefly after a state "deletion"
    const state = loadState();
    delete state[String(userId)];
    saveState(state);
  },

  /**
   * Workflow Methods
   */
  startWorkflow: (userId, workflowName, initialData, steps) => {
    const state = loadState();
    state[String(userId)] = {
      isWorkflow: true,
      workflow: workflowName,
      currentStep: 0,
      totalSteps: steps.length,
      steps: steps, // Array of tool keys
      completedSteps: {},
      data: initialData || {},
      lastUpdated: Date.now(),
      tool: steps[0] // Set initial tool for the orchestrator
    };
    saveState(state);
  },

  getCurrentStep: (userId) => {
    const session = loadState()[String(userId)];
    return (session && session.isWorkflow) ? session.currentStep : null;
  },

  advanceWorkflow: (userId, stepResult) => {
    const state = loadState();
    const session = state[String(userId)];
    if (session && session.isWorkflow) {
      session.completedSteps[session.currentStep] = stepResult;
      session.currentStep += 1;
      if (session.currentStep < session.totalSteps) {
        session.tool = session.steps[session.currentStep];
      }
      session.lastUpdated = Date.now();
      saveState(state);
      return true;
    }
    return false;
  },

  setTempFile: (userId, buffer) => {
    const state = loadState();
    const session = state[String(userId)];
    if (session) {
      const tempPath = path.join(os.tmpdir(), `docenter_${userId}_${Date.now()}.tmp`);
      fs.writeFileSync(tempPath, buffer);
      session.tempFilePath = tempPath;
      saveState(state);
    }
  },

  getWorkflowData: (userId) => {
    const session = loadState()[String(userId)];
    return (session && session.isWorkflow) ? { data: session.data, results: session.completedSteps } : null;
  },

  isInWorkflow: (userId) => {
    const session = loadState()[String(userId)];
    return !!(session && session.isWorkflow);
  },

  cancelWorkflow: (userId) => {
    module.exports.delete(userId);
  },

  getActiveCount: () => {
    const state = loadState();
    return Object.keys(state).length;
  }
};