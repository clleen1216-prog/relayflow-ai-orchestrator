import type {
  AITool,
  ChannelType,
  LinkedAccount,
  RelayStep,
  RelayTask,
  RoutingMode,
  WorkspaceState,
} from '../types';
import { getToolEffectiveSummary, normalizeToolWithSummary } from './toolCredits';

const PRIORITY_BASE_WEIGHT: Record<RelayTask['priority'], number> = {
  P1: 75,
  P2: 50,
  P3: 25,
};

export function computeTaskPriorityScore(task: RelayTask): number {
  const base = PRIORITY_BASE_WEIGHT[task.priority];
  const carryoverBonus = task.daysCarriedOver * 18;
  const completedCount = task.steps.filter((s) => s.status === 'completed').length;
  const progressBonus =
    task.steps.length > 0 ? Math.round((completedCount / task.steps.length) * 20) : 0;
  return base + carryoverBonus + progressBonus;
}

export interface TaskProgressEta {
  totalSteps: number;
  completedSteps: number;
  inProgressSteps: number;
  stashedSteps: number;
  isRunning: boolean;
  totalMinutes: number;
  completedMinutes: number;
  remainingMinutes: number;
  progressPct: number;
  scheduledCompletionTime: string | null;
  realtimeEtaTime: string | null;
  etaSummary: string;
}

export function getLocalDateStr(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getLocalTimeStr(nowMs = Date.now(), withSeconds = false): string {
  const d = new Date(nowMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function getTaskProgressAndEta(
  task: RelayTask,
  nowMs = Date.now(),
  currentDate?: string
): TaskProgressEta {
  const totalSteps = task.steps.length;
  const completedSteps = task.steps.filter((s) => s.status === 'completed').length;
  const inProgressSteps = task.steps.filter((s) => s.status === 'in_progress').length;
  const stashedSteps = task.steps.filter((s) => s.status === 'stashed').length;
  const isRunning = inProgressSteps > 0;

  const totalMinutes = task.steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);
  const completedMinutes = task.steps
    .filter((s) => s.status === 'completed')
    .reduce((sum, s) => sum + s.estimatedMinutes, 0);
  const remainingMinutes = Math.max(0, totalMinutes - completedMinutes);
  const progressPct =
    totalMinutes > 0
      ? Math.round((completedMinutes / totalMinutes) * 100)
      : totalSteps > 0
      ? Math.round((completedSteps / totalSteps) * 100)
      : 0;

  let scheduledCompletionTime: string | null = null;
  for (let i = task.steps.length - 1; i >= 0; i -= 1) {
    const slot = task.steps[i].scheduledSlot;
    if (!slot) continue;
    const match = slot.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
    if (match) {
      scheduledCompletionTime = match[2];
      break;
    }
  }

  let realtimeEtaTime: string | null = null;
  if (remainingMinutes > 0 && task.status !== 'completed') {
    const etaDate = new Date(nowMs + remainingMinutes * 60_000);
    realtimeEtaTime = `${String(etaDate.getHours()).padStart(2, '0')}:${String(
      etaDate.getMinutes()
    ).padStart(2, '0')}`;
  }

  // Detect if a today-scheduled slot has already fallen behind current wall-clock time
  const realToday = getLocalDateStr(nowMs);
  let scheduledSlotInPast = false;
  if (scheduledCompletionTime && (!currentDate || currentDate === realToday)) {
    const [sh, sm] = scheduledCompletionTime.split(':').map(Number);
    const schedMins = sh * 60 + sm;
    const nowDate = new Date(nowMs);
    const nowMins = nowDate.getHours() * 60 + nowDate.getMinutes();
    if (schedMins < nowMins && nowMins - schedMins < 720) {
      scheduledSlotInPast = true;
    }
  }

  let etaSummary = '已結案';
  if (task.status !== 'completed' && completedSteps < totalSteps) {
    if (stashedSteps > 0) {
      etaSummary = `剩 ${remainingMinutes} 分鐘 · 部分暫存至明日`;
    } else if (isRunning && realtimeEtaTime) {
      etaSummary = `即時預估 ${realtimeEtaTime} 完成（剩 ${remainingMinutes} 分鐘）`;
    } else if (scheduledCompletionTime && !scheduledSlotInPast) {
      etaSummary = `排程預計 ${scheduledCompletionTime} 完成（剩 ${remainingMinutes} 分鐘）`;
    } else if (realtimeEtaTime) {
      etaSummary = `約需 ${remainingMinutes} 分鐘（即刻執行約 ${realtimeEtaTime} 完成）`;
    }
  }

  return {
    totalSteps,
    completedSteps,
    inProgressSteps,
    stashedSteps,
    isRunning,
    totalMinutes,
    completedMinutes,
    remainingMinutes,
    progressPct,
    scheduledCompletionTime,
    realtimeEtaTime,
    etaSummary,
  };
}

function formatMinutesToTime(totalMinutesFromMidnight: number): string {
  const normalized = ((totalMinutesFromMidnight % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().slice(0, 10);
}

const SEED_TASK_IDS = new Set([
  'task-q4-strategy',
  'task-checkout-refactor',
  'task-bixby-meeting-notes',
  'task-funnel-carryover',
]);

export function syncWorkspaceToRealDate(
  state: WorkspaceState,
  nowMs = Date.now()
): { state: WorkspaceState; changed: boolean } {
  const realToday = getLocalDateStr(nowMs);
  if (!state.currentDate || state.currentDate >= realToday) {
    return { state, changed: false };
  }

  const realYesterday = addDaysToDateStr(realToday, -1);
  const realTomorrow = addDaysToDateStr(realToday, 1);

  const updatedTasks = state.tasks.map((task) => {
    if (SEED_TASK_IDS.has(task.id)) {
      return {
        ...task,
        createdDate: task.id === 'task-funnel-carryover' ? realYesterday : realToday,
        deadlineDate: task.id === 'task-checkout-refactor' ? realTomorrow : realToday,
      };
    }
    return task;
  });

  return {
    changed: true,
    state: {
      ...state,
      currentDate: realToday,
      tasks: updatedTasks,
    },
  };
}

interface SimPool {
  webRem: number;
  appRem: number;
  isShared: boolean;
  totalRem: number;
  totalLimit: number;
}

function chooseChannelForTool(
  tool: AITool,
  pool: SimPool,
  cost: number,
  stepChannelOverride?: ChannelType
): ChannelType | null {
  const pref = stepChannelOverride ?? tool.preferredChannel ?? 'auto';
  const webAvailable = Boolean(tool.channels?.web.available ?? true);
  const appAvailable = Boolean(tool.channels?.app.available ?? false);

  if (pool.isShared) {
    if (pool.totalRem < cost) return null;
    if (pref === 'app' && appAvailable) return 'app';
    return webAvailable ? 'web' : 'app';
  }

  if (pref === 'web') {
    if (webAvailable && pool.webRem >= cost) return 'web';
    if (appAvailable && pool.appRem >= cost) return 'app';
    return null;
  }

  if (pref === 'app') {
    if (appAvailable && pool.appRem >= cost) return 'app';
    if (webAvailable && pool.webRem >= cost) return 'web';
    return null;
  }

  // Auto mode: prefer web if healthy, otherwise shift to independent App pool!
  if (webAvailable && pool.webRem >= cost) return 'web';
  if (appAvailable && pool.appRem >= cost) return 'app';
  return null;
}

function deductSimPool(pool: SimPool, channel: ChannelType, cost: number) {
  if (pool.isShared) {
    pool.totalRem = Math.max(0, pool.totalRem - cost);
    pool.webRem = pool.totalRem;
    pool.appRem = pool.totalRem;
  } else if (channel === 'app') {
    pool.appRem = Math.max(0, pool.appRem - cost);
    pool.totalRem = pool.webRem + pool.appRem;
  } else {
    pool.webRem = Math.max(0, pool.webRem - cost);
    pool.totalRem = pool.webRem + pool.appRem;
  }
}

function pickToolAndChannelForStep(
  step: RelayStep,
  toolsMap: Record<string, AITool>,
  simPools: Record<string, SimPool>,
  mode: RoutingMode
): { toolId: string; channel: ChannelType; cost: number; note: string } | null {
  const preferred = toolsMap[step.preferredToolId];
  const preferredPool = preferred ? simPools[preferred.id] : undefined;
  const preferredCost = preferred ? preferred.costPerStep : step.creditCost;

  const findFallback = (reasonPrefix: string) => {
    const candidateIds = preferred ? preferred.fallbackToolIds : [];
    const sortedFallbacks = candidateIds
      .map((id) => toolsMap[id])
      .filter((t): t is AITool => Boolean(t && t.enabled))
      .filter((t) => {
        const p = simPools[t.id];
        return p && chooseChannelForTool(t, p, t.costPerStep) !== null;
      })
      .sort((a, b) => (simPools[b.id]?.totalRem ?? 0) - (simPools[a.id]?.totalRem ?? 0));

    if (sortedFallbacks.length > 0) {
      const chosen = sortedFallbacks[0];
      const ch = chooseChannelForTool(chosen, simPools[chosen.id], chosen.costPerStep)!;
      const chText = ch === 'app' ? 'App 版' : '網頁版';
      return {
        toolId: chosen.id,
        channel: ch,
        cost: chosen.costPerStep,
        note: `${reasonPrefix}，已自動分流至 ${chosen.name}（${chText}）`,
      };
    }

    const anyAvailable = Object.values(toolsMap)
      .filter((t) => {
        if (!t.enabled) return false;
        const p = simPools[t.id];
        return p && chooseChannelForTool(t, p, t.costPerStep) !== null;
      })
      .sort((a, b) => (simPools[b.id]?.totalRem ?? 0) - (simPools[a.id]?.totalRem ?? 0));

    if (anyAvailable.length > 0 && mode !== 'strength_first') {
      const chosen = anyAvailable[0];
      const ch = chooseChannelForTool(chosen, simPools[chosen.id], chosen.costPerStep)!;
      const chText = ch === 'app' ? 'App 版' : '網頁版';
      return {
        toolId: chosen.id,
        channel: ch,
        cost: chosen.costPerStep,
        note: `${reasonPrefix}，已調度備援 ${chosen.name}（${chText}）`,
      };
    }

    return null;
  };

  if (mode === 'quota_balanced' && preferred && preferred.enabled && preferredPool) {
    const remRatio =
      preferredPool.totalLimit > 0 ? preferredPool.totalRem / preferredPool.totalLimit : 0;
    if (remRatio < 0.28 && preferred.fallbackToolIds.length > 0) {
      const abundantFallback = preferred.fallbackToolIds
        .map((id) => toolsMap[id])
        .find((t) => {
          if (!t || !t.enabled) return false;
          const p = simPools[t.id];
          if (!p || p.totalLimit === 0) return false;
          return (
            chooseChannelForTool(t, p, t.costPerStep) !== null &&
            p.totalRem / p.totalLimit >= 0.45
          );
        });
      if (abundantFallback) {
        const ch = chooseChannelForTool(
          abundantFallback,
          simPools[abundantFallback.id],
          abundantFallback.costPerStep
        )!;
        const chText = ch === 'app' ? 'App 版' : '網頁版';
        return {
          toolId: abundantFallback.id,
          channel: ch,
          cost: abundantFallback.costPerStep,
          note: `${preferred.name} 免費額度偏低（剩 ${preferredPool.totalRem}），已均衡分流至 ${abundantFallback.name}（${chText}）`,
        };
      }
    }
  }

  if (preferred && preferred.enabled && preferredPool) {
    const chosenChannel = chooseChannelForTool(
      preferred,
      preferredPool,
      preferredCost,
      step.preferredChannel
    );
    if (chosenChannel) {
      const webExhaustedSwitchToApp =
        chosenChannel === 'app' &&
        preferred.channels?.web.available &&
        preferredPool.webRem < preferredCost &&
        !preferredPool.isShared &&
        step.preferredChannel !== 'app';

      const chLabel = chosenChannel === 'app' ? 'App 版' : '網頁版';
      return {
        toolId: preferred.id,
        channel: chosenChannel,
        cost: preferredCost,
        note: webExhaustedSwitchToApp
          ? `${preferred.name} 網頁版額度已滿，自動切換至 App 版獨立免費池`
          : step.preferredChannel === chosenChannel
          ? `依指定通道執行：${preferred.name}（${chLabel}）`
          : `依強項「${step.capabilityTag}」匹配 ${preferred.name}（${chLabel}）`,
      };
    }
  }

  const reason = !preferred?.enabled
    ? `${preferred?.name ?? step.preferredToolId} 已停用`
    : `${preferred.name} Web 與 App 免費額度均不足`;

  return findFallback(reason);
}

export function runAutoScheduleAndRoute(
  state: WorkspaceState,
  linkedAccounts: LinkedAccount[] = [],
  nowMs = Date.now()
): WorkspaceState {
  const normalizedTools = state.tools.map((t) => normalizeToolWithSummary(t, linkedAccounts));
  const toolsMap: Record<string, AITool> = {};
  const simPools: Record<string, SimPool> = {};

  for (const tool of normalizedTools) {
    toolsMap[tool.id] = tool;
    const summary = getToolEffectiveSummary(tool, linkedAccounts);
    simPools[tool.id] = {
      webRem: summary.webRemaining,
      appRem: summary.appRemaining,
      isShared: summary.isSharedQuota,
      totalRem: summary.totalRemaining,
      totalLimit: summary.totalLimit,
    };
  }

  const scoredTasks = state.tasks.map((t) => ({
    ...t,
    carryoverScore: computeTaskPriorityScore(t),
  }));

  const sortedIds = [...scoredTasks]
    .filter((t) => t.status !== 'completed')
    .sort((a, b) => {
      const aRunning = a.steps.some((s) => s.status === 'in_progress') ? 1 : 0;
      const bRunning = b.steps.some((s) => s.status === 'in_progress') ? 1 : 0;
      if (bRunning !== aRunning) return bRunning - aRunning;
      if (state.routingMode === 'urgency_first') {
        const pDiff = PRIORITY_BASE_WEIGHT[b.priority] - PRIORITY_BASE_WEIGHT[a.priority];
        if (pDiff !== 0) return pDiff;
      }
      return b.carryoverScore - a.carryoverScore;
    })
    .map((t) => t.id);

  const realToday = getLocalDateStr(nowMs);
  const nowDate = new Date(nowMs);
  let cursorMinutes =
    !state.currentDate || state.currentDate <= realToday
      ? nowDate.getHours() * 60 + nowDate.getMinutes()
      : 9 * 60;
  let usedTimeToday = 0;

  const updatedTaskMap: Record<string, RelayTask> = {};

  for (const task of scoredTasks) {
    if (task.status === 'completed' || task.steps.every((s) => s.status === 'completed')) {
      updatedTaskMap[task.id] = { ...task, status: 'completed', autoStashReason: null };
    }
  }

  for (const taskId of sortedIds) {
    const task = scoredTasks.find((t) => t.id === taskId)!;
    let taskHasStashedStep = false;
    const stashReasons: string[] = [];

    const newSteps: RelayStep[] = task.steps.map((step) => {
      if (step.status === 'completed') {
        return step;
      }

      if (usedTimeToday + step.estimatedMinutes > state.dailyTimeBudgetMinutes) {
        taskHasStashedStep = true;
        stashReasons.push('今日排程時數已達上限');
        return {
          ...step,
          status: 'stashed',
          scheduledSlot: null,
          routingNote: '超出今日可用工時預算，已自動暫存待明日優先執行',
        };
      }

      const route = pickToolAndChannelForStep(step, toolsMap, simPools, state.routingMode);
      if (!route) {
        taskHasStashedStep = true;
        const prefName = toolsMap[step.preferredToolId]?.name ?? step.preferredToolId;
        stashReasons.push(`${prefName} 與備援工具今日 Web/App 免費額度均已耗盡`);
        return {
          ...step,
          status: 'stashed',
          scheduledSlot: null,
          routingNote: '今日免費額度已滿，暫存至明日額度重置後接力執行',
        };
      }

      deductSimPool(simPools[route.toolId], route.channel, route.cost);
      const startTime = formatMinutesToTime(cursorMinutes);
      cursorMinutes += step.estimatedMinutes;
      const endTime = formatMinutesToTime(cursorMinutes);
      cursorMinutes += 5;
      usedTimeToday += step.estimatedMinutes;

      return {
        ...step,
        assignedToolId: route.toolId,
        assignedChannel: route.channel,
        creditCost: route.cost,
        status: step.status === 'in_progress' ? 'in_progress' : 'scheduled',
        scheduledSlot: `${startTime} - ${endTime}`,
        routingNote: route.note,
      };
    });

    const allCompleted = newSteps.every((s) => s.status === 'completed');
    const hasInProgress = newSteps.some((s) => s.status === 'in_progress');
    const uniqueReasons = Array.from(new Set(stashReasons));

    updatedTaskMap[task.id] = {
      ...task,
      steps: newSteps,
      status: allCompleted
        ? 'completed'
        : taskHasStashedStep
        ? 'stashed'
        : hasInProgress
        ? 'active'
        : 'scheduled',
      autoStashReason:
        uniqueReasons.length > 0
          ? `${uniqueReasons.join('；')}，已完成步驟已保存，未完成部分自動暫存至隔日。`
          : task.daysCarriedOver > 0
          ? `跨日接力第 ${task.daysCarriedOver} 天，系統已自動調升優先權重 (${task.carryoverScore} 分)。`
          : null,
    };
  }

  const finalTasks = scoredTasks
    .map((t) => updatedTaskMap[t.id] ?? t)
    .sort((a, b) => {
      if (a.status === 'completed' && b.status !== 'completed') return 1;
      if (a.status !== 'completed' && b.status === 'completed') return -1;
      return b.carryoverScore - a.carryoverScore;
    });

  return {
    ...state,
    tools: normalizedTools,
    tasks: finalTasks,
  };
}

function scoreTaskProgressDepth(task: RelayTask): number {
  const completedSteps = task.steps.filter((s) => s.status === 'completed').length;
  const inProgressSteps = task.steps.filter((s) => s.status === 'in_progress').length;
  const outputChars = task.steps.reduce((sum, s) => sum + (s.output?.trim().length ?? 0), 0);
  const deliverableChars = task.finalDeliverable?.trim().length ?? 0;
  const updatedMs = task.updatedAt ? Date.parse(task.updatedAt) || 0 : 0;
  return (
    completedSteps * 100_000 +
    inProgressSteps * 10_000 +
    Math.min(9_000, outputChars + deliverableChars) +
    Math.floor(updatedMs / 100_000_000)
  );
}

export function mergeTasksPreservingProgress(
  localTasks: RelayTask[],
  remoteTasks: RelayTask[],
  deletedIds: Set<string> = new Set()
): RelayTask[] {
  const merged = new Map<string, RelayTask>();

  for (const task of remoteTasks) {
    if (!deletedIds.has(task.id)) {
      merged.set(task.id, task);
    }
  }

  for (const localTask of localTasks) {
    if (deletedIds.has(localTask.id)) continue;
    const existing = merged.get(localTask.id);
    if (!existing) {
      merged.set(localTask.id, localTask);
      continue;
    }

    const localTs = localTask.updatedAt ? Date.parse(localTask.updatedAt) || 0 : 0;
    const remoteTs = existing.updatedAt ? Date.parse(existing.updatedAt) || 0 : 0;
    const localDepth = scoreTaskProgressDepth(localTask);
    const remoteDepth = scoreTaskProgressDepth(existing);

    const winner =
      localDepth > remoteDepth || (localDepth === remoteDepth && localTs >= remoteTs)
        ? localTask
        : existing;

    // Merge individual step outputs so neither side's completed/typed output is lost
    const mergedSteps = winner.steps.map((step) => {
      const alt = (winner === localTask ? existing : localTask).steps.find((s) => s.id === step.id);
      if (!alt) return step;
      const bestOutput =
        (step.output?.length ?? 0) >= (alt.output?.length ?? 0) ? step.output : alt.output;
      return {
        ...step,
        output: bestOutput,
        startedAt: step.startedAt ?? alt.startedAt,
        completedAt: step.completedAt ?? alt.completedAt,
      };
    });

    merged.set(localTask.id, {
      ...winner,
      steps: mergedSteps,
      finalDeliverable:
        (winner.finalDeliverable?.length ?? 0) >=
        ((winner === localTask ? existing : localTask).finalDeliverable?.length ?? 0)
          ? winner.finalDeliverable
          : (winner === localTask ? existing : localTask).finalDeliverable,
    });
  }

  return Array.from(merged.values());
}

export function buildToolLaunchUrl(
  toolId: string,
  officialUrl: string,
  fullPrompt: string
): { url: string; prefilledInUrl: boolean } {
  const snippet = fullPrompt.trim().slice(0, 1400);
  if (!snippet) return { url: officialUrl, prefilledInUrl: false };
  const encoded = encodeURIComponent(snippet);
  switch (toolId) {
    case 'perplexity':
      return { url: `https://www.perplexity.ai/search?q=${encoded}`, prefilledInUrl: true };
    case 'chatgpt':
      return { url: `https://chatgpt.com/?q=${encoded}`, prefilledInUrl: true };
    case 'grok':
      return { url: `https://grok.com/?q=${encoded}`, prefilledInUrl: true };
    case 'copilot':
      return { url: `https://copilot.microsoft.com/?q=${encoded}`, prefilledInUrl: true };
    case 'claude':
      return { url: `https://claude.ai/new?q=${encoded}`, prefilledInUrl: true };
    default:
      return { url: officialUrl, prefilledInUrl: false };
  }
}

export function executeEndOfDayRollover(
  state: WorkspaceState,
  linkedAccounts: LinkedAccount[] = []
): WorkspaceState {
  const fromDate = state.currentDate;
  const toDate = addDaysToDateStr(fromDate, 1);

  const completedTasks = state.tasks.filter(
    (t) => t.status === 'completed' || t.steps.every((s) => s.status === 'completed')
  );
  const unfinishedTasks = state.tasks.filter(
    (t) => t.status !== 'completed' && !t.steps.every((s) => s.status === 'completed')
  );

  const resetTools: AITool[] = state.tools.map((tool) => {
    const nextTool: AITool = {
      ...tool,
      usedToday: 0,
      resetHoursRemaining: 24,
      channels: tool.channels
        ? {
            web: { ...tool.channels.web, usedToday: 0 },
            app: { ...tool.channels.app, usedToday: 0 },
          }
        : undefined,
    };
    return normalizeToolWithSummary(nextTool, linkedAccounts);
  });

  const carriedTasks: RelayTask[] = unfinishedTasks.map((task) => {
    const nextDaysCarried = task.daysCarriedOver + 1;
    const updatedTask: RelayTask = {
      ...task,
      daysCarriedOver: nextDaysCarried,
      status: 'active',
      steps: task.steps.map((step) =>
        step.status === 'completed'
          ? step
          : {
              ...step,
              status: 'pending',
              scheduledSlot: null,
              assignedToolId: step.preferredToolId,
            }
      ),
    };
    updatedTask.carryoverScore = computeTaskPriorityScore(updatedTask);
    return updatedTask;
  });

  carriedTasks.sort((a, b) => b.carryoverScore - a.carryoverScore);

  const newLog = {
    id: `log-${fromDate}-${Date.now()}`,
    fromDate,
    toDate,
    stashedCount: carriedTasks.length,
    completedCount: completedTasks.length,
    summary:
      carriedTasks.length > 0
        ? `日終結算完成：${completedTasks.length} 項任務已結案，${carriedTasks.length} 項未完成任務已保留進度並於 ${toDate} 重新分配優先順序，所有 Web 與 App 免費額度已重置。`
        : `日終結算完成：今日 ${completedTasks.length} 項任務全數達成！所有 Web 與 App 免費額度已重置為明日準備。`,
    reorderedTitles: carriedTasks.map((t) => `${t.title}（優先權重 ${t.carryoverScore}）`),
  };

  const nextState: WorkspaceState = {
    ...state,
    currentDate: toDate,
    tools: resetTools,
    tasks: [...carriedTasks, ...completedTasks],
    carryoverLogs: [newLog, ...state.carryoverLogs],
  };

  return runAutoScheduleAndRoute(nextState, linkedAccounts);
}
