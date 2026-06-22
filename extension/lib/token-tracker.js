/**
 * Token usage tracking and cost estimation for Omni-Context.
 * Estimates tokens using chars/4 heuristic, persists daily usage
 * to chrome.storage.local under the 'tokenUsage' key.
 */

import { estimateTokens } from './utils.js';

// Cost per 1M tokens [input, output] in USD
const MODEL_COSTS = {
  'gpt-4o':          [2.50, 10.00],
  'gpt-4o-mini':     [0.15, 0.60],
  'claude-sonnet':   [3.00, 15.00],
  'claude-haiku':    [0.25, 1.25],
  'gemini-pro':      [1.25, 5.00],
  'gemini-flash':    [0.075, 0.30],
  'deepseek-chat':   [0.14, 0.28],
};

// Max context window (input tokens) per model family
export const MODEL_CONTEXT_LIMITS = {
  'gpt-4o':              128000,
  'gpt-4o-mini':         128000,
  'gpt-4-turbo':         128000,
  'gpt-3.5-turbo':       16385,
  'claude-3-5-sonnet':   200000,
  'claude-3-5-haiku':    200000,
  'claude-3-opus':       200000,
  'claude-sonnet':       200000,
  'claude-haiku':        200000,
  'gemini-2.0-flash':    1048576,
  'gemini-1.5-pro':      2097152,
  'gemini-1.5-flash':    1048576,
  'gemini-pro':          32760,
  'llama-3.3-70b':       131072,
  'llama-3.1-sonar':     127072,
  'mixtral':             32768,
  'mistral-large':       128000,
  'deepseek-chat':       128000,
  'deepseek-coder':      128000,
  'grok-2':              131072,
  'command-r-plus':      128000,
};

/**
 * Look up the context window limit for a model name.
 * Matches partially (e.g. 'gpt-4o-2024-08-06' matches 'gpt-4o').
 * Returns 128000 as a safe default for unknown models.
 * @param {string} model  Model identifier.
 * @returns {number} Max input tokens for the model.
 */
export function getModelContextLimit(model) {
  if (!model) return 128000;
  const lower = model.toLowerCase();
  for (const [pattern, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (lower.includes(pattern)) return limit;
  }
  return 128000;
}

/**
 * Get today's date key in YYYY-MM-DD format.
 * @returns {string}
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load the full tokenUsage object from chrome.storage.local.
 * @returns {Promise<Object>} Map of date → {providers: {[provider]: {[model]: {input, output, queries}}}}
 */
async function loadUsage() {
  const result = await chrome.storage.local.get('tokenUsage');
  return result.tokenUsage || {};
}

/**
 * Save the full tokenUsage object to chrome.storage.local.
 * @param {Object} usage
 */
async function saveUsage(usage) {
  await chrome.storage.local.set({ tokenUsage: usage });
}

/**
 * Track token usage for a single query.
 * @param {string} provider - Provider name (e.g. 'openai', 'anthropic')
 * @param {string} model - Model identifier (e.g. 'gpt-4o')
 * @param {string} inputText - Full input/context text sent to the model
 * @param {string} outputText - Full response text from the model
 */
export async function trackUsage(provider, model, inputText, outputText) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  const day = todayKey();

  const usage = await loadUsage();

  if (!usage[day]) {
    usage[day] = { providers: {} };
  }
  if (!usage[day].providers[provider]) {
    usage[day].providers[provider] = {};
  }
  if (!usage[day].providers[provider][model]) {
    usage[day].providers[provider][model] = { input: 0, output: 0, queries: 0 };
  }

  usage[day].providers[provider][model].input += inputTokens;
  usage[day].providers[provider][model].output += outputTokens;
  usage[day].providers[provider][model].queries += 1;

  // Prune entries older than 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  for (const key of Object.keys(usage)) {
    if (key < cutoffKey) delete usage[key];
  }

  await saveUsage(usage);

  return { inputTokens, outputTokens };
}

/**
 * Get usage data for today.
 * @returns {Promise<{input: number, output: number, queries: number, providers: Object}>}
 */
export async function getDailyUsage() {
  const usage = await loadUsage();
  const day = todayKey();
  const dayData = usage[day];

  if (!dayData) {
    return { input: 0, output: 0, queries: 0, providers: {} };
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalQueries = 0;

  for (const provider of Object.values(dayData.providers)) {
    for (const model of Object.values(provider)) {
      totalInput += model.input;
      totalOutput += model.output;
      totalQueries += model.queries;
    }
  }

  return {
    input: totalInput,
    output: totalOutput,
    queries: totalQueries,
    providers: dayData.providers,
  };
}

/**
 * Get usage data for the last 7 days.
 * @returns {Promise<{input: number, output: number, queries: number, providers: Object, daily: Object}>}
 */
export async function getWeeklyUsage() {
  const usage = await loadUsage();
  const now = new Date();

  let totalInput = 0;
  let totalOutput = 0;
  let totalQueries = 0;
  const aggregatedProviders = {};
  const daily = {};

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const dayData = usage[key];

    if (!dayData) continue;

    let dayInput = 0;
    let dayOutput = 0;
    let dayQueries = 0;

    for (const [provName, models] of Object.entries(dayData.providers)) {
      if (!aggregatedProviders[provName]) aggregatedProviders[provName] = {};
      for (const [modelName, stats] of Object.entries(models)) {
        if (!aggregatedProviders[provName][modelName]) {
          aggregatedProviders[provName][modelName] = { input: 0, output: 0, queries: 0 };
        }
        aggregatedProviders[provName][modelName].input += stats.input;
        aggregatedProviders[provName][modelName].output += stats.output;
        aggregatedProviders[provName][modelName].queries += stats.queries;
        dayInput += stats.input;
        dayOutput += stats.output;
        dayQueries += stats.queries;
      }
    }

    totalInput += dayInput;
    totalOutput += dayOutput;
    totalQueries += dayQueries;
    daily[key] = { input: dayInput, output: dayOutput, queries: dayQueries };
  }

  return {
    input: totalInput,
    output: totalOutput,
    queries: totalQueries,
    providers: aggregatedProviders,
    daily,
  };
}

/**
 * Estimate cost based on token usage and known model pricing.
 * Matches model names partially (e.g. 'gpt-4o-2024-08-06' matches 'gpt-4o').
 * @param {Object} providers - {[provider]: {[model]: {input, output}}}
 * @returns {{total: number, breakdown: Array<{provider: string, model: string, cost: number}>}}
 */
export function getCostEstimate(providers) {
  let total = 0;
  const breakdown = [];

  for (const [provName, models] of Object.entries(providers || {})) {
    for (const [modelName, stats] of Object.entries(models)) {
      const cost = estimateModelCost(modelName, stats.input, stats.output);
      if (cost > 0) {
        total += cost;
        breakdown.push({ provider: provName, model: modelName, cost });
      }
    }
  }

  return { total, breakdown };
}

/**
 * Match a model name to known pricing and calculate cost.
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} Estimated cost in USD
 */
function estimateModelCost(model, inputTokens, outputTokens) {
  const lower = model.toLowerCase();

  for (const [pattern, [inputRate, outputRate]] of Object.entries(MODEL_COSTS)) {
    if (lower.includes(pattern)) {
      return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
    }
  }

  return 0;
}

/**
 * Reset all usage data.
 * @returns {Promise<void>}
 */
export async function resetUsage() {
  await chrome.storage.local.remove('tokenUsage');
}
