import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  CalendarClock,
  CalendarSync,
  Coins,
  FastForward,
  GitMerge,
  LogIn,
  Menu,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  UserCheck,
  X,
} from 'lucide-react';
import { AccountsView } from './components/AccountsView';
import { CarryoverQueueView } from './components/CarryoverQueueView';
import { CreateTaskModal } from './components/CreateTaskModal';
import { CreditMatrixView } from './components/CreditMatrixView';
import { ExportDeployView } from './components/ExportDeployView';
import { OverviewScheduleView } from './components/OverviewScheduleView';
import { RelayStudioView } from './components/RelayStudioView';
import { createInitialWorkspaceState, INITIAL_WORKSPACE_STATE } from './data/seedData';
import {
  auth,
  deleteLinkedAccount,
  ensureUserProfile,
  loadLinkedAccounts,
  loadUserWorkspace,
  saveLinkedAccount,
  saveUserWorkspace,
  signInWithGooglePopup,
  signOutAccount,
} from './firebase';
import type {
  AITool,
  AutoRelayStatus,
  ChannelType,
  LinkedAccount,
  RelayStep,
  RelayTask,
  RoutingMode,
  WorkspaceState,
} from './types';
import {
  executeEndOfDayRollover,
  getLocalDateStr,
  getLocalTimeStr,
  mergeTasksPreservingProgress,
  runAutoScheduleAndRoute,
  syncWorkspaceToRealDate,
} from './utils/scheduler';
import { deductToolChannelCredit } from './utils/toolCredits';

type NavTab = 'overview' | 'relay' | 'credits' | 'carryover' | 'accounts' | 'export';

const STORAGE_KEY = 'relayflow_workspace_v2';
const DELETED_IDS_KEY = 'relayflow_deleted_ids_v1';

function loadDeletedTaskIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DELETED_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveDeletedTaskIds(ids: Set<string>): void {
  try {
    localStorage.setItem(DELETED_IDS_KEY, JSON.stringify(Array.from(ids).slice(-200)));
  } catch {
    // Ignore storage quota errors
  }
}

const TAB_META: Record<NavTab, { label: string; subtitle: string }> = {
  overview: { label: '總覽與排程', subtitle: '今日資源平衡與時間軸調度' },
  relay: { label: '接力任務台', subtitle: '多模型上下文交棒與全自動接力執行' },
  credits: { label: '免費額度庫', subtitle: '網頁版 vs App 版免費資源評估' },
  carryover: { label: '任務歷史與跨日', subtitle: '歷史任務進度存檔、已完成交付與跨日重排' },
  accounts: { label: '個人帳號與擴充', subtitle: 'Google 登入雲端同步與額外帳號疊加' },
  export: { label: '匯出與部署', subtitle: '本機 ZIP 下載、GitHub Push 與 Vercel.com 上線' },
};

const DEFAULT_EXAMPLE_TASK_IDS = new Set([
  'task-q4-strategy',
  'task-checkout-refactor',
  'task-bixby-meeting-notes',
  'task-funnel-carryover',
]);

function stripDefaultExampleTasks(ws: WorkspaceState): {
  state: WorkspaceState;
  stripped: boolean;
} {
  const nextTasks = ws.tasks.filter((t) => !DEFAULT_EXAMPLE_TASK_IDS.has(t.id));
  const nextLogs = (ws.carryoverLogs ?? []).filter(
    (log) =>
      !(
        log.reorderedTitles?.includes('【跨日暫存】SaaS 訂閱轉換率漏斗歸因分析') &&
        log.id.startsWith('log-')
      )
  );
  const stripped = nextTasks.length !== ws.tasks.length || nextLogs.length !== (ws.carryoverLogs ?? []).length;
  if (!stripped) {
    return { state: ws, stripped: false };
  }

  const nextTools =
    nextTasks.length === 0
      ? ws.tools.map((t) => ({
          ...t,
          usedToday: 0,
          channels: t.channels
            ? {
                web: { ...t.channels.web, usedToday: 0 },
                app: { ...t.channels.app, usedToday: 0 },
              }
            : undefined,
        }))
      : ws.tools;

  return {
    stripped: true,
    state: {
      ...ws,
      tools: nextTools,
      tasks: nextTasks,
      carryoverLogs: nextLogs,
    },
  };
}

function mergeSeedToolsIntoExisting(existing: WorkspaceState): WorkspaceState {
  const existingIds = new Set(existing.tools.map((t) => t.id));
  const missingTools = INITIAL_WORKSPACE_STATE.tools.filter((t) => !existingIds.has(t.id));
  if (missingTools.length === 0) return existing;
  return {
    ...existing,
    tools: [...existing.tools, ...missingTools],
  };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [state, setState] = useState<WorkspaceState>(() => {
    const initNow = Date.now();
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const merged = mergeSeedToolsIntoExisting(JSON.parse(cached) as WorkspaceState);
        const cleaned = stripDefaultExampleTasks(merged).state;
        const synced = syncWorkspaceToRealDate(cleaned, initNow).state;
        return runAutoScheduleAndRoute(synced, [], initNow);
      }
    } catch {
      // Ignore storage errors
    }
    return runAutoScheduleAndRoute(createInitialWorkspaceState(initNow), [], initNow);
  });

  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [selectedTaskId, setSelectedTaskId] = useState<string>(state.tasks[0]?.id ?? '');
  const [selectedStepId, setSelectedStepId] = useState<string>(
    state.tasks[0]?.steps.find((s) => s.status !== 'completed')?.id ??
      state.tasks[0]?.steps[0]?.id ??
      ''
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [startPromptTask, setStartPromptTask] = useState<{
    taskId: string;
    title: string;
    firstStepId: string;
    firstStepTitle: string;
    firstToolName: string;
    firstChannelLabel: string;
    estimatedMinutes: number;
    hasOtherUnfinished: boolean;
  } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [autoRelayStatus, setAutoRelayStatus] = useState<AutoRelayStatus | null>(null);
  const skipNextCloudSaveRef = useRef(false);
  const deletedTaskIdsRef = useRef<Set<string>>(loadDeletedTaskIds());
  const autoRelayAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const stateRef = useRef(state);
  stateRef.current = state;
  const linkedAccountsRef = useRef(linkedAccounts);
  linkedAccountsRef.current = linkedAccounts;

  // Real-time local clock & automatic midnight rollover check
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const realTodayStr = getLocalDateStr(nowMs);
  useEffect(() => {
    if (state.currentDate && state.currentDate < realTodayStr) {
      setState((prev) => {
        const { state: synced, changed } = syncWorkspaceToRealDate(prev, nowMs);
        if (!changed) return prev;
        return runAutoScheduleAndRoute(synced, linkedAccounts, nowMs);
      });
    }
  }, [realTodayStr, state.currentDate, nowMs, linkedAccounts]);

  // Firebase Auth listener & Firestore hydration
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);

      if (currentUser) {
        setSyncStatus('syncing');
        setSyncError(null);
        try {
          await ensureUserProfile(currentUser);
          const [cloudWs, cloudAccounts] = await Promise.all([
            loadUserWorkspace(currentUser.uid),
            loadLinkedAccounts(currentUser.uid),
          ]);
          setLinkedAccounts(cloudAccounts);

          if (cloudWs && Array.isArray(cloudWs.tools) && cloudWs.tools.length > 0) {
            const syncNow = Date.now();
            const mergedToolsWs = mergeSeedToolsIntoExisting(cloudWs);
            const { state: cleaned, stripped } = stripDefaultExampleTasks(mergedToolsWs);
            const { state: dateSynced, changed } = syncWorkspaceToRealDate(cleaned, syncNow);
            const mergedTasks = mergeTasksPreservingProgress(
              stateRef.current.tasks,
              dateSynced.tasks,
              deletedTaskIdsRef.current
            );
            const localContributed = mergedTasks.some((t) => {
              const remoteMatch = dateSynced.tasks.find((r) => r.id === t.id);
              return !remoteMatch || t.updatedAt !== remoteMatch.updatedAt;
            });
            if (!changed && !stripped && !localContributed) {
              skipNextCloudSaveRef.current = true;
            }
            const scheduled = runAutoScheduleAndRoute(
              { ...dateSynced, tasks: mergedTasks },
              cloudAccounts,
              syncNow
            );
            setState(scheduled);
            if (scheduled.tasks[0]) {
              setSelectedTaskId((prev) =>
                scheduled.tasks.some((t) => t.id === prev) ? prev : scheduled.tasks[0].id
              );
              setSelectedStepId((prev) => {
                if (scheduled.tasks.some((t) => t.steps.some((s) => s.id === prev))) return prev;
                return (
                  scheduled.tasks[0].steps.find((s) => s.status !== 'completed')?.id ??
                  scheduled.tasks[0].steps[0]?.id ??
                  ''
                );
              });
            } else {
              setSelectedTaskId('');
              setSelectedStepId('');
            }
          } else {
            // First sign-in: push current local workspace to Firestore
            setState((prev) => {
              const syncNow = Date.now();
              const synced = syncWorkspaceToRealDate(prev, syncNow).state;
              const scheduled = runAutoScheduleAndRoute(synced, cloudAccounts, syncNow);
              void saveUserWorkspace(currentUser.uid, scheduled);
              return scheduled;
            });
          }
          setSyncStatus('synced');
        } catch (err) {
          setSyncStatus('error');
          setSyncError(err instanceof Error ? err.message : '雲端同步失敗');
        }
      } else {
        setLinkedAccounts([]);
        setSyncStatus('idle');
      }
    });

    return () => unsubscribe();
  }, []);

  // Load local server state when unauthenticated (merging without overwriting local progress)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/state')
      .then((res) => (res.ok ? res.json() : null))
      .then((serverData: WorkspaceState | null) => {
        if (!cancelled && !auth.currentUser && serverData && Array.isArray(serverData.tools)) {
          const syncNow = Date.now();
          const merged = mergeSeedToolsIntoExisting(serverData);
          const cleaned = stripDefaultExampleTasks(merged).state;
          const dateSynced = syncWorkspaceToRealDate(cleaned, syncNow).state;
          const preservedTasks = mergeTasksPreservingProgress(
            stateRef.current.tasks,
            dateSynced.tasks,
            deletedTaskIdsRef.current
          );
          const scheduled = runAutoScheduleAndRoute(
            { ...dateSynced, tasks: preservedTasks },
            [],
            syncNow
          );
          setState(scheduled);
          if (scheduled.tasks[0]) {
            setSelectedTaskId((prev) =>
              scheduled.tasks.some((t) => t.id === prev) ? prev : scheduled.tasks[0].id
            );
          } else {
            setSelectedTaskId('');
            setSelectedStepId('');
          }
        }
      })
      .catch(() => {
        // Offline fallback remains active
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Persist workspace to localStorage, Express API, and Firestore (when signed in)
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore quota errors
    }

    fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }).catch(() => {
      // Silent fallback
    });

    if (user) {
      if (skipNextCloudSaveRef.current) {
        skipNextCloudSaveRef.current = false;
        return;
      }
      setSyncStatus('syncing');
      saveUserWorkspace(user.uid, state)
        .then(() => setSyncStatus('synced'))
        .catch((err) => {
          setSyncStatus('error');
          setSyncError(err instanceof Error ? err.message : '無法寫入雲端工作區');
        });
    }
  }, [state, hydrated, user]);

  // Flush workspace state synchronously before page unload or tab hide
  useEffect(() => {
    const flushNow = () => {
      const snapshot = stateRef.current;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Ignore quota errors
      }
      try {
        void fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
          keepalive: true,
        });
      } catch {
        // Ignore network errors during unload
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushNow();
      }
    };

    window.addEventListener('beforeunload', flushNow);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('beforeunload', flushNow);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setTimeout(() => {
      setNotice((curr) => (curr === msg ? null : curr));
    }, 4500);
  };

  const commitState = (
    updater: (prev: WorkspaceState) => WorkspaceState,
    reschedule = true,
    nextAccounts: LinkedAccount[] = linkedAccounts
  ) => {
    setState((prev) => {
      const updated = updater(prev);
      return reschedule ? runAutoScheduleAndRoute(updated, nextAccounts) : updated;
    });
  };

  const handleSignIn = async () => {
    try {
      const signedUser = await signInWithGooglePopup();
      showNotice(`歡迎登入 ${signedUser.displayName || signedUser.email}，已啟用個人雲端與額度擴充功能。`);
    } catch (err) {
      showNotice(err instanceof Error ? `登入失敗：${err.message}` : 'Google 登入已取消或失敗');
    }
  };

  const handleSignOut = async () => {
    await signOutAccount();
    setLinkedAccounts([]);
    commitState((prev) => prev, true, []);
    showNotice('已登出個人帳號，切換回本機訪客模式。');
  };

  const handleAddLinkedAccount = async (
    draft: Omit<LinkedAccount, 'id' | 'ownerId'>
  ) => {
    if (!user) return;
    const newAccount: LinkedAccount = {
      ...draft,
      id: `acc-${Date.now()}`,
      ownerId: user.uid,
    };
    await saveLinkedAccount(user.uid, newAccount, true);
    const nextAccounts = [...linkedAccounts, newAccount];
    setLinkedAccounts(nextAccounts);
    commitState((prev) => prev, true, nextAccounts);
    showNotice(`已綁定帳號「${newAccount.label}」並重新計算各 AI 每日可用 Credits。`);
  };

  const handleToggleLinkedAccount = async (account: LinkedAccount) => {
    if (!user) return;
    const updated = { ...account, enabled: !account.enabled };
    await saveLinkedAccount(user.uid, updated, false);
    const nextAccounts = linkedAccounts.map((a) => (a.id === account.id ? updated : a));
    setLinkedAccounts(nextAccounts);
    commitState((prev) => prev, true, nextAccounts);
    showNotice(
      updated.enabled
        ? `已啟用「${updated.label}」額度疊加。`
        : `已暫停「${updated.label}」額度疊加。`
    );
  };

  const handleDeleteLinkedAccount = async (accountId: string) => {
    if (!user) return;
    await deleteLinkedAccount(user.uid, accountId);
    const nextAccounts = linkedAccounts.filter((a) => a.id !== accountId);
    setLinkedAccounts(nextAccounts);
    commitState((prev) => prev, true, nextAccounts);
    showNotice('已移除綁定帳號並重算今日可用額度。');
  };

  const handleChangeRoutingMode = (mode: RoutingMode) => {
    commitState((prev) => ({ ...prev, routingMode: mode }), true);
    showNotice('已切換分流策略並重新最佳化今日排程。');
  };

  const handleChangeTimeBudget = (minutes: number) => {
    commitState((prev) => ({ ...prev, dailyTimeBudgetMinutes: minutes }), true);
    showNotice(`已更新每日工時上限為 ${minutes} 分鐘並重排時間軸。`);
  };

  const handleRunAutoSchedule = () => {
    commitState((prev) => prev, true);
    showNotice('已完成任務優先順序與 Web/App 免費額度自動分流重排。');
  };

  const handleSelectTaskStep = (taskId: string, stepId: string) => {
    setSelectedTaskId(taskId);
    setSelectedStepId(stepId);
    setActiveTab('relay');
  };

  const handleUpdateTool = (toolId: string, patch: Partial<AITool>) => {
    commitState(
      (prev) => ({
        ...prev,
        tools: prev.tools.map((t) => (t.id === toolId ? { ...t, ...patch } : t)),
      }),
      true
    );
  };

  const handleResetAllCredits = () => {
    commitState(
      (prev) => ({
        ...prev,
        tools: prev.tools.map((t) => ({
          ...t,
          usedToday: 0,
          resetHoursRemaining: 24,
          channels: t.channels
            ? {
                web: { ...t.channels.web, usedToday: 0 },
                app: { ...t.channels.app, usedToday: 0 },
              }
            : undefined,
        })),
      }),
      true
    );
    showNotice('已重置所有 AI 工具之網頁版與 App 版今日免費額度。');
  };

  const handleAddCustomTool = (tool: AITool) => {
    commitState((prev) => ({ ...prev, tools: [...prev.tools, tool] }), true);
    showNotice(`已將「${tool.name}」加入免費額度庫並納入自動排程。`);
  };

  const handleChangeStepTool = (taskId: string, stepId: string, newToolId: string) => {
    const newTool = state.tools.find((t) => t.id === newToolId);
    const defaultChannel: ChannelType =
      newTool?.channels && !newTool.channels.web.available && newTool.channels.app.available
        ? 'app'
        : 'web';
    commitState(
      (prev) => ({
        ...prev,
        tasks: prev.tasks.map((task) =>
          task.id !== taskId
            ? task
            : {
                ...task,
                steps: task.steps.map((step) =>
                  step.id !== stepId
                    ? step
                    : {
                        ...step,
                        preferredToolId: newToolId,
                        assignedToolId: newToolId,
                        preferredChannel:
                          newTool?.channels && !newTool.channels.web.available
                            ? 'app'
                            : undefined,
                        assignedChannel: defaultChannel,
                        creditCost: newTool?.costPerStep ?? step.creditCost,
                        routingNote: `已手動指派由 ${newTool?.name ?? newToolId} 執行`,
                      }
                ),
              }
        ),
      }),
      true
    );
  };

  const handleChangeStepChannel = (taskId: string, stepId: string, channel: ChannelType) => {
    commitState(
      (prev) => ({
        ...prev,
        tasks: prev.tasks.map((task) =>
          task.id !== taskId
            ? task
            : {
                ...task,
                steps: task.steps.map((step) =>
                  step.id !== stepId
                    ? step
                    : {
                        ...step,
                        preferredChannel: channel,
                        assignedChannel: channel,
                        routingNote: `已手動切換至 ${channel === 'app' ? 'App 版' : '網頁版'}通道`,
                      }
                ),
              }
        ),
      }),
      true
    );
    showNotice(`已切換該步驟至 ${channel === 'app' ? 'App 版' : '網頁版'}並重新計算額度分流。`);
  };

  const persistSnapshotImmediately = (nextState: WorkspaceState) => {
    stateRef.current = nextState;
    setState(nextState);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } catch {
      // Ignore quota errors
    }
  };

  const executeStepWithApi = async (
    task: RelayTask,
    step: RelayStep,
    tools: AITool[]
  ): Promise<string> => {
    const assignedTool = tools.find((t) => t.id === step.assignedToolId);
    const channel: ChannelType = step.assignedChannel === 'app' ? 'app' : 'web';
    const prevSteps = task.steps.filter(
      (s) => s.order < step.order && s.output.trim().length > 0
    );

    const response = await fetch('/api/relay/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskTitle: task.title,
        taskGoal: task.goal,
        stepTitle: step.title,
        capabilityTag: step.capabilityTag,
        assignedToolName: `${assignedTool?.name ?? step.assignedToolId} (${
          channel === 'app' ? 'App 版' : '網頁版'
        })`,
        toolStrengths: assignedTool?.strengths ?? [],
        promptTemplate: step.promptTemplate,
        previousOutputs: prevSteps.map((s) => ({
          stepTitle: s.title,
          toolName: tools.find((t) => t.id === s.assignedToolId)?.name ?? s.assignedToolId,
          channelLabel: s.assignedChannel === 'app' ? 'App 版' : '網頁版',
          output: s.output,
        })),
      }),
    });

    const data = (await response.json()) as { output?: string; error?: string };
    if (!response.ok || !data.output) {
      throw new Error(data.error ?? `第 ${step.order} 棒「${step.title}」執行失敗`);
    }
    return data.output;
  };

  const finalizeDeliverableWithApi = async (
    task: RelayTask,
    tools: AITool[]
  ): Promise<string> => {
    const stepOutputs = task.steps.map((s) => ({
      order: s.order,
      stepTitle: s.title,
      toolName: tools.find((t) => t.id === s.assignedToolId)?.name ?? s.assignedToolId,
      channelLabel: s.assignedChannel === 'app' ? 'App 版' : '網頁版',
      output: s.output,
    }));

    try {
      const response = await fetch('/api/relay/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: task.title,
          taskGoal: task.goal,
          stepOutputs,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { deliverable?: string };
        if (data.deliverable?.trim()) {
          return data.deliverable.trim();
        }
      }
    } catch {
      // Fallback to structured synthesis below
    }

    return stepOutputs
      .map(
        (s) =>
          `## 第 ${s.order} 棒｜${s.stepTitle}（${s.toolName}${
            s.channelLabel ? ` · ${s.channelLabel}` : ''
          }）\n\n${s.output}`
      )
      .join('\n\n---\n\n');
  };

  const handleUpdateStepOutput = (taskId: string, stepId: string, output: string) => {
    const nowIso = new Date().toISOString();
    commitState(
      (prev) => ({
        ...prev,
        tasks: prev.tasks.map((task) =>
          task.id !== taskId
            ? task
            : {
                ...task,
                updatedAt: nowIso,
                steps: task.steps.map((step) =>
                  step.id === stepId ? { ...step, output } : step
                ),
              }
        ),
      }),
      false
    );
  };

  const handleStartStep = (taskId: string, stepId: string) => {
    const nowIso = new Date().toISOString();
    commitState(
      (prev) => ({
        ...prev,
        tasks: prev.tasks.map((task) =>
          task.id !== taskId
            ? task
            : {
                ...task,
                status: task.status === 'completed' ? 'completed' : 'active',
                updatedAt: nowIso,
                steps: task.steps.map((step) =>
                  step.id === stepId && step.status !== 'completed'
                    ? {
                        ...step,
                        status: 'in_progress',
                        startedAt: step.startedAt ?? nowIso,
                      }
                    : step
                ),
              }
        ),
      }),
      false
    );
  };

  const handleCompleteStep = (
    taskId: string,
    stepId: string,
    output: string,
    channel: ChannelType
  ) => {
    let nextStepToFocus: string | null = null;
    let completedToolName = '';
    let completedTaskSnapshot: RelayTask | null = null;
    const nowIso = new Date().toISOString();

    commitState((prev) => {
      const targetTask = prev.tasks.find((t) => t.id === taskId);
      const targetStep = targetTask?.steps.find((s) => s.id === stepId);
      if (!targetTask || !targetStep) return prev;

      const usedToolId = targetStep.assignedToolId;
      const cost = targetStep.creditCost;
      const toolObj = prev.tools.find((t) => t.id === usedToolId);
      completedToolName = toolObj?.name ?? usedToolId;

      const nextTools = prev.tools.map((tool) =>
        tool.id === usedToolId
          ? deductToolChannelCredit(tool, cost, channel, linkedAccounts)
          : tool
      );

      const nextTasks = prev.tasks.map((task) => {
        if (task.id !== taskId) return task;
        const updatedSteps = task.steps.map((s) =>
          s.id === stepId
            ? {
                ...s,
                status: 'completed' as const,
                assignedChannel: channel,
                output,
                startedAt: s.startedAt ?? nowIso,
                completedAt: nowIso,
                executionMode: s.executionMode ?? ('manual' as const),
              }
            : s
        );
        const upcoming = updatedSteps.find((s) => s.status !== 'completed');
        if (upcoming) nextStepToFocus = upcoming.id;
        const allDone = updatedSteps.every((s) => s.status === 'completed');
        const nextTask: RelayTask = {
          ...task,
          steps: updatedSteps,
          updatedAt: nowIso,
          completedAt: allDone ? task.completedAt ?? nowIso : task.completedAt,
          status: allDone ? ('completed' as const) : task.status,
        };
        if (allDone) completedTaskSnapshot = nextTask;
        return nextTask;
      });

      return { ...prev, tools: nextTools, tasks: nextTasks };
    }, true);

    const chText = channel === 'app' ? 'App 版' : '網頁版';
    if (nextStepToFocus) {
      setSelectedStepId(nextStepToFocus);
      showNotice(`已完成步驟並扣除 ${completedToolName} (${chText}) 額度，上下文已自動交棒至下一棒。`);
    } else {
      showNotice(`已完成接力任務最後一步並扣除 ${completedToolName} (${chText}) 額度，正在彙整最終交付成果並永久存檔。`);
      if (completedTaskSnapshot) {
        const snapshotForFinalize: RelayTask = completedTaskSnapshot;
        void finalizeDeliverableWithApi(snapshotForFinalize, stateRef.current.tools).then(
          (deliverable) => {
            commitState(
              (prev) => ({
                ...prev,
                tasks: prev.tasks.map((t) =>
                  t.id === taskId ? { ...t, finalDeliverable: deliverable } : t
                ),
              }),
              false
            );
          }
        );
      }
    }
  };

  const handleAutoRunSingleStep = async (taskId: string, stepId: string) => {
    const startSnap = stateRef.current;
    const task = startSnap.tasks.find((t) => t.id === taskId);
    const step = task?.steps.find((s) => s.id === stepId);
    if (!task || !step) return;

    const nowIso = new Date().toISOString();
    const markingRunning: WorkspaceState = {
      ...startSnap,
      tasks: startSnap.tasks.map((t) =>
        t.id !== taskId
          ? t
          : {
              ...t,
              status: 'active',
              updatedAt: nowIso,
              steps: t.steps.map((s) =>
                s.id === stepId && s.status !== 'completed'
                  ? { ...s, status: 'in_progress', startedAt: s.startedAt ?? nowIso }
                  : s
              ),
            }
      ),
    };
    persistSnapshotImmediately(markingRunning);

    const output = await executeStepWithApi(task, step, startSnap.tools);

    const doneIso = new Date().toISOString();
    const afterSnap = stateRef.current;
    const latestTask = afterSnap.tasks.find((t) => t.id === taskId);
    const latestStep = latestTask?.steps.find((s) => s.id === stepId);
    if (!latestTask || !latestStep) return;

    const channel: ChannelType = latestStep.assignedChannel === 'app' ? 'app' : 'web';
    const nextTools = afterSnap.tools.map((tool) =>
      tool.id === latestStep.assignedToolId
        ? deductToolChannelCredit(tool, latestStep.creditCost, channel, linkedAccountsRef.current)
        : tool
    );

    let nextStepId: string | null = null;
    let finishedTask: RelayTask | null = null;

    const nextTasks = afterSnap.tasks.map((t) => {
      if (t.id !== taskId) return t;
      const updatedSteps = t.steps.map((s) =>
        s.id === stepId
          ? {
              ...s,
              status: 'completed' as const,
              assignedChannel: channel,
              output,
              startedAt: s.startedAt ?? nowIso,
              completedAt: doneIso,
              executionMode: 'auto' as const,
            }
          : s
      );
      const upcoming = updatedSteps.find((s) => s.status !== 'completed');
      if (upcoming) nextStepId = upcoming.id;
      const allDone = updatedSteps.every((s) => s.status === 'completed');
      const nextT: RelayTask = {
        ...t,
        steps: updatedSteps,
        updatedAt: doneIso,
        completedAt: allDone ? doneIso : t.completedAt,
        status: allDone ? ('completed' as const) : ('active' as const),
      };
      if (allDone) finishedTask = nextT;
      return nextT;
    });

    const scheduled = runAutoScheduleAndRoute(
      { ...afterSnap, tools: nextTools, tasks: nextTasks },
      linkedAccountsRef.current,
      Date.now()
    );
    persistSnapshotImmediately(scheduled);

    const toolName =
      afterSnap.tools.find((t) => t.id === latestStep.assignedToolId)?.name ??
      latestStep.assignedToolId;

    if (nextStepId) {
      setSelectedStepId(nextStepId);
      showNotice(`已完成第 ${latestStep.order} 棒（${toolName}）並自動交棒至下一步。`);
    } else if (finishedTask) {
      const deliverable = await finalizeDeliverableWithApi(finishedTask, scheduled.tools);
      const finalState: WorkspaceState = {
        ...stateRef.current,
        tasks: stateRef.current.tasks.map((t) =>
          t.id === taskId ? { ...t, finalDeliverable: deliverable } : t
        ),
      };
      persistSnapshotImmediately(finalState);
      showNotice(`已完成全部步驟並產出最終交付成果（已永久保存於任務歷史）。`);
    }
  };

  const handleStopAutoRelay = () => {
    autoRelayAbortRef.current.aborted = true;
    showNotice('已送出暫停指令，當前步驟寫入後將安全停駐，所有已完成進度皆會完整保留。');
  };

  const handleStartAutoRelay = async (taskId: string) => {
    if (autoRelayStatus) {
      showNotice('已有全自動接力任務正在背景執行中，請稍候或先暫停目前接力。');
      return;
    }

    autoRelayAbortRef.current.aborted = false;
    setSelectedTaskId(taskId);
    setActiveTab('relay');

    try {
      while (!autoRelayAbortRef.current.aborted) {
        const currentSnap = stateRef.current;
        const currentTask = currentSnap.tasks.find((t) => t.id === taskId);
        if (!currentTask) break;

        const nextStep = currentTask.steps.find((s) => s.status !== 'completed');
        if (!nextStep) break;

        const toolObj = currentSnap.tools.find((t) => t.id === nextStep.assignedToolId);
        const toolName = toolObj?.name ?? nextStep.assignedToolId;

        setSelectedStepId(nextStep.id);
        setAutoRelayStatus({
          taskId,
          currentStepId: nextStep.id,
          currentStepOrder: nextStep.order,
          totalSteps: currentTask.steps.length,
          currentToolName: toolName,
          phase: 'executing_step',
          error: null,
        });

        const stepStartIso = new Date().toISOString();
        const runningState: WorkspaceState = {
          ...currentSnap,
          tasks: currentSnap.tasks.map((t) =>
            t.id !== taskId
              ? t
              : {
                  ...t,
                  status: 'active',
                  updatedAt: stepStartIso,
                  steps: t.steps.map((s) =>
                    s.id === nextStep.id
                      ? {
                          ...s,
                          status: 'in_progress',
                          startedAt: s.startedAt ?? stepStartIso,
                        }
                      : s
                  ),
                }
          ),
        };
        persistSnapshotImmediately(runningState);

        const output = await executeStepWithApi(currentTask, nextStep, currentSnap.tools);

        const stepDoneIso = new Date().toISOString();
        const postSnap = stateRef.current;
        const channel: ChannelType = nextStep.assignedChannel === 'app' ? 'app' : 'web';
        const nextTools = postSnap.tools.map((tool) =>
          tool.id === nextStep.assignedToolId
            ? deductToolChannelCredit(
                tool,
                nextStep.creditCost,
                channel,
                linkedAccountsRef.current
              )
            : tool
        );

        const nextTasks = postSnap.tasks.map((t) => {
          if (t.id !== taskId) return t;
          const updatedSteps = t.steps.map((s) =>
            s.id === nextStep.id
              ? {
                  ...s,
                  status: 'completed' as const,
                  assignedChannel: channel,
                  output,
                  startedAt: s.startedAt ?? stepStartIso,
                  completedAt: stepDoneIso,
                  executionMode: 'auto' as const,
                }
              : s
          );
          const allDone = updatedSteps.every((s) => s.status === 'completed');
          return {
            ...t,
            steps: updatedSteps,
            updatedAt: stepDoneIso,
            completedAt: allDone ? stepDoneIso : t.completedAt,
            status: allDone ? ('completed' as const) : ('active' as const),
          };
        });

        const scheduled = runAutoScheduleAndRoute(
          { ...postSnap, tools: nextTools, tasks: nextTasks },
          linkedAccountsRef.current,
          Date.now()
        );
        persistSnapshotImmediately(scheduled);
      }

      if (autoRelayAbortRef.current.aborted) {
        showNotice('已暫停全自動接力，已完成之步驟進度與產出已安全保存。');
        return;
      }

      const finalSnap = stateRef.current;
      const completedTask = finalSnap.tasks.find((t) => t.id === taskId);
      if (completedTask && completedTask.steps.every((s) => s.status === 'completed')) {
        setAutoRelayStatus({
          taskId,
          currentStepId: completedTask.steps[completedTask.steps.length - 1]?.id ?? '',
          currentStepOrder: completedTask.steps.length,
          totalSteps: completedTask.steps.length,
          currentToolName: '整合彙整',
          phase: 'finalizing',
          error: null,
        });

        const deliverable = await finalizeDeliverableWithApi(completedTask, finalSnap.tools);
        const doneIso = new Date().toISOString();
        const finalizedState: WorkspaceState = {
          ...stateRef.current,
          tasks: stateRef.current.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  status: 'completed',
                  completedAt: t.completedAt ?? doneIso,
                  updatedAt: doneIso,
                  finalDeliverable: deliverable,
                }
              : t
          ),
        };
        persistSnapshotImmediately(finalizedState);
        showNotice(`「${completedTask.title}」全自動接力完成！最終交付成果已生成並存檔於歷史紀錄。`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '全自動接力中斷';
      showNotice(`全自動接力中斷：${msg}（先前已完成步驟進度已保留，可隨時續跑）`);
    } finally {
      setAutoRelayStatus(null);
    }
  };

  const handleStashStep = (taskId: string, stepId: string) => {
    const nowIso = new Date().toISOString();
    commitState(
      (prev) => ({
        ...prev,
        tasks: prev.tasks.map((task) =>
          task.id !== taskId
            ? task
            : {
                ...task,
                status: 'stashed',
                updatedAt: nowIso,
                autoStashReason: '使用者手動暫存此步驟，待明日重新分配優先執行',
                steps: task.steps.map((s) =>
                  s.id === stepId
                    ? {
                        ...s,
                        status: 'stashed',
                        scheduledSlot: null,
                        routingNote: '已暫存至明日優先佇列',
                      }
                    : s
                ),
              }
        ),
      }),
      false
    );
    showNotice('已暫存步驟進度與前序脈絡，將於跨日結算時優先重排。');
  };

  const handleDeleteTask = (taskId: string) => {
    deletedTaskIdsRef.current.add(taskId);
    saveDeletedTaskIds(deletedTaskIdsRef.current);
    commitState((prev) => {
      const remaining = prev.tasks.filter((t) => t.id !== taskId);
      if (selectedTaskId === taskId && remaining[0]) {
        setSelectedTaskId(remaining[0].id);
        setSelectedStepId(remaining[0].steps[0]?.id ?? '');
      }
      return { ...prev, tasks: remaining };
    }, true);
    showNotice('已移除任務並釋放原排程時間與額度預算。');
  };

  const handleCreateTask = (newTask: RelayTask) => {
    const nowIso = new Date().toISOString();
    const stampedTask: RelayTask = {
      ...newTask,
      updatedAt: newTask.updatedAt ?? nowIso,
    };
    deletedTaskIdsRef.current.delete(stampedTask.id);
    saveDeletedTaskIds(deletedTaskIdsRef.current);

    const otherUnfinished = state.tasks.filter(
      (t) => t.status !== 'completed' && !t.steps.every((s) => s.status === 'completed')
    );
    const otherRunning = otherUnfinished.filter((t) =>
      t.steps.some((s) => s.status === 'in_progress')
    );

    const scheduleNow = Date.now();
    const scheduledState = runAutoScheduleAndRoute(
      {
        ...state,
        tasks: [stampedTask, ...state.tasks],
      },
      linkedAccounts,
      scheduleNow
    );

    setState(scheduledState);

    const scheduledTask =
      scheduledState.tasks.find((t) => t.id === stampedTask.id) ?? stampedTask;
    const firstStep = scheduledTask.steps[0];

    setSelectedTaskId(scheduledTask.id);
    setSelectedStepId(firstStep?.id ?? '');
    setActiveTab('relay');

    if (otherRunning.length === 0 && firstStep && firstStep.status !== 'stashed') {
      const firstTool = scheduledState.tools.find((t) => t.id === firstStep.assignedToolId);
      setStartPromptTask({
        taskId: scheduledTask.id,
        title: scheduledTask.title,
        firstStepId: firstStep.id,
        firstStepTitle: firstStep.title,
        firstToolName: firstTool?.name ?? firstStep.assignedToolId,
        firstChannelLabel: firstStep.assignedChannel === 'app' ? 'App 版' : '網頁版',
        estimatedMinutes: firstStep.estimatedMinutes,
        hasOtherUnfinished: otherUnfinished.length > 0,
      });
    } else {
      showNotice(`已建立接力任務「${stampedTask.title}」並完成自動排程分流。`);
    }
  };

  const handleCloneTask = (taskId: string) => {
    const source = stateRef.current.tasks.find((t) => t.id === taskId);
    if (!source) return;
    const cloneNow = Date.now();
    const todayStr = getLocalDateStr(cloneNow);
    const nowIso = new Date(cloneNow).toISOString();
    const newId = `task-${cloneNow}`;

    const clonedTask: RelayTask = {
      ...source,
      id: newId,
      createdDate: todayStr,
      deadlineDate: todayStr,
      daysCarriedOver: 0,
      status: 'scheduled',
      autoStashReason: null,
      updatedAt: nowIso,
      completedAt: undefined,
      finalDeliverable: undefined,
      steps: source.steps.map((s, idx) => ({
        ...s,
        id: `step-${cloneNow}-${idx + 1}`,
        status: 'pending',
        scheduledSlot: null,
        output: '',
        startedAt: undefined,
        completedAt: undefined,
        executionMode: undefined,
      })),
    };

    deletedTaskIdsRef.current.delete(newId);
    saveDeletedTaskIds(deletedTaskIdsRef.current);

    const scheduledState = runAutoScheduleAndRoute(
      {
        ...stateRef.current,
        tasks: [clonedTask, ...stateRef.current.tasks],
      },
      linkedAccountsRef.current,
      cloneNow
    );
    setState(scheduledState);

    const scheduledClone = scheduledState.tasks.find((t) => t.id === newId) ?? clonedTask;
    setSelectedTaskId(scheduledClone.id);
    setSelectedStepId(scheduledClone.steps[0]?.id ?? '');
    setActiveTab('relay');
    showNotice(`已複製任務「${clonedTask.title}」建立新回合，可選擇全自動接力執行到底。`);
  };

  const handleExecuteRollover = () => {
    commitState((prev) => executeEndOfDayRollover(prev, linkedAccounts), false);
    setActiveTab('overview');
    showNotice('日終結算完成：已重置所有 Web 與 App 免費額度，並將未完成任務依新權重重新排入今日。');
  };

  const handleResetDemo = async () => {
    autoRelayAbortRef.current.aborted = true;
    setAutoRelayStatus(null);
    for (const t of stateRef.current.tasks) {
      deletedTaskIdsRef.current.add(t.id);
    }
    saveDeletedTaskIds(deletedTaskIdsRef.current);

    const resetNow = Date.now();
    try {
      const res = await fetch('/api/state/reset', { method: 'POST' });
      const fresh = res.ok
        ? ((await res.json()) as WorkspaceState)
        : createInitialWorkspaceState(resetNow);
      const cleaned = stripDefaultExampleTasks(fresh).state;
      const synced = syncWorkspaceToRealDate(cleaned, resetNow).state;
      const scheduled = runAutoScheduleAndRoute(synced, linkedAccounts, resetNow);
      setState(scheduled);
      setSelectedTaskId('');
      setSelectedStepId('');
      showNotice('已清除所有預設與現有任務，並重置所有 AI 免費額度。');
    } catch {
      const scheduled = runAutoScheduleAndRoute(
        createInitialWorkspaceState(resetNow),
        linkedAccounts,
        resetNow
      );
      setState(scheduled);
      setSelectedTaskId('');
      setSelectedStepId('');
      showNotice('已清除所有預設與現有任務，並重置所有 AI 免費額度。');
    }
  };

  const navItems: Array<{ id: NavTab; label: string; icon: typeof CalendarClock }> = [
    { id: 'overview', label: '總覽與排程', icon: CalendarClock },
    { id: 'relay', label: '接力任務台', icon: GitMerge },
    { id: 'credits', label: '免費額度庫', icon: Coins },
    { id: 'carryover', label: '任務歷史與跨日', icon: CalendarSync },
    { id: 'accounts', label: '個人帳號與擴充', icon: UserCheck },
    { id: 'export', label: '匯出與部署', icon: Rocket },
  ];

  const unfinishedCount = state.tasks.filter((t) => t.status !== 'completed').length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-30">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <span className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap">
            RelayFlow
          </span>
        </div>

        <nav aria-label="主要導覽" className="flex-1 px-3 py-5 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.id === 'relay' && (
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      isActive ? 'text-slate-300' : 'text-slate-400'
                    }`}
                  >
                    {unfinishedCount}
                  </span>
                )}
                {item.id === 'credits' && (
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      isActive ? 'text-slate-300' : 'text-slate-400'
                    }`}
                  >
                    {state.tools.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          {/* Account Quick Status */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
            {user ? (
              <>
                <div className="text-xs font-semibold text-slate-900 truncate">
                  {user.displayName || user.email}
                </div>
                <div className="text-xs text-slate-500 truncate font-mono">
                  {linkedAccounts.filter((a) => a.enabled).length > 0
                    ? `已疊加 ${linkedAccounts.filter((a) => a.enabled).length} 組擴充帳號`
                    : '雲端帳號已連線'}
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('accounts')}
                  className="w-full text-left text-xs font-medium text-blue-600 hover:underline"
                >
                  管理綁定帳號與額度
                </button>
              </>
            ) : (
              <>
                <div className="text-xs font-medium text-slate-700">訪客本機模式</div>
                <button
                  type="button"
                  onClick={handleSignIn}
                  disabled={!authReady}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  登入帳號擴充額度
                </button>
              </>
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{state.currentDate > realTodayStr ? '工作日 (預排明日)' : '即時工作日'}</span>
            <span className="font-mono tabular-nums text-slate-900 font-semibold">
              {state.currentDate} {getLocalTimeStr(nowMs, true)}
            </span>
          </div>

          <button
            type="button"
            onClick={handleResetDemo}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            清空任務並重置額度
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-64 max-w-[80vw] bg-white h-full border-r border-slate-200 flex flex-col z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-lg font-bold text-slate-900 font-display">RelayFlow</span>
              <button
                type="button"
                aria-label="關閉選單"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium ${
                      isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb on left, 1 Primary CTA on right */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-8 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="開啟導覽選單"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2 text-sm min-w-0 truncate">
              <span className="text-slate-400 hidden sm:inline">工作台</span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-900 truncate">
                {TAB_META[activeTab].label}
              </h1>
              <span className="text-slate-300 hidden md:inline">·</span>
              <span className="text-xs text-slate-500 hidden md:inline truncate">
                {TAB_META[activeTab].subtitle}
              </span>
            </div>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setIsCreateOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              新增接力任務
            </button>
          </div>
        </header>

        {/* Action Feedback Banner */}
        {notice && (
          <div className="px-4 sm:px-8 pt-4">
            <div className="bg-blue-50 border border-blue-200 text-blue-900 px-4 py-2.5 rounded-lg text-xs flex items-center justify-between gap-4">
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label="關閉提示"
                className="text-blue-600 hover:text-blue-900"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Viewport Content */}
        <main className="flex-1 px-4 sm:px-8 py-6 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewScheduleView
              state={state}
              nowMs={nowMs}
              linkedAccounts={linkedAccounts}
              onChangeRoutingMode={handleChangeRoutingMode}
              onChangeTimeBudget={handleChangeTimeBudget}
              onRunAutoSchedule={handleRunAutoSchedule}
              onSelectTaskStep={handleSelectTaskStep}
              onNavigateTab={setActiveTab}
            />
          )}

          {activeTab === 'relay' && (
            <RelayStudioView
              tasks={state.tasks}
              tools={state.tools}
              linkedAccounts={linkedAccounts}
              currentDate={state.currentDate}
              nowMs={nowMs}
              selectedTaskId={selectedTaskId}
              selectedStepId={selectedStepId}
              autoRelayStatus={autoRelayStatus}
              onSelectTask={setSelectedTaskId}
              onSelectStep={setSelectedStepId}
              onChangeStepTool={handleChangeStepTool}
              onChangeStepChannel={handleChangeStepChannel}
              onStartStep={handleStartStep}
              onUpdateStepOutput={handleUpdateStepOutput}
              onCompleteStep={handleCompleteStep}
              onStashStep={handleStashStep}
              onDeleteTask={handleDeleteTask}
              onStartAutoRelay={handleStartAutoRelay}
              onStopAutoRelay={handleStopAutoRelay}
              onAutoRunSingleStep={handleAutoRunSingleStep}
              onCloneTask={handleCloneTask}
            />
          )}

          {activeTab === 'credits' && (
            <CreditMatrixView
              tools={state.tools}
              linkedAccounts={linkedAccounts}
              onUpdateTool={handleUpdateTool}
              onResetAllCredits={handleResetAllCredits}
              onAddCustomTool={handleAddCustomTool}
            />
          )}

          {activeTab === 'carryover' && (
            <CarryoverQueueView
              state={state}
              nowMs={nowMs}
              onExecuteRollover={handleExecuteRollover}
              onOpenTask={(taskId) => {
                const task = state.tasks.find((t) => t.id === taskId);
                const nextStep =
                  task?.steps.find((s) => s.status !== 'completed') ?? task?.steps[0];
                if (task && nextStep) {
                  handleSelectTaskStep(task.id, nextStep.id);
                }
              }}
              onCloneTask={handleCloneTask}
            />
          )}

          {activeTab === 'accounts' && (
            <AccountsView
              user={user}
              authReady={authReady}
              syncStatus={syncStatus}
              syncError={syncError}
              tools={state.tools}
              linkedAccounts={linkedAccounts}
              onSignIn={handleSignIn}
              onSignOut={handleSignOut}
              onAddLinkedAccount={handleAddLinkedAccount}
              onToggleLinkedAccount={handleToggleLinkedAccount}
              onDeleteLinkedAccount={handleDeleteLinkedAccount}
            />
          )}

          {activeTab === 'export' && (
            <ExportDeployView workspaceState={state} />
          )}
        </main>
      </div>

      <CreateTaskModal
        isOpen={isCreateOpen}
        currentDate={state.currentDate}
        tools={state.tools}
        linkedAccounts={linkedAccounts}
        onClose={() => setIsCreateOpen(false)}
        onCreateTask={handleCreateTask}
      />

      {/* Ask whether to start newly created task immediately when no other task is running */}
      {startPromptTask && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-prompt-title"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-blue-700">
                {startPromptTask.hasOtherUnfinished
                  ? '目前無其他執行中任務'
                  : '目前工作台沒有其他待辦任務'}
              </p>
              <h2 id="start-prompt-title" className="text-base font-semibold text-slate-900">
                是否現在開始執行此任務？
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                已建立「<strong className="text-slate-900">{startPromptTask.title}</strong>」並完成排程。第 1 棒「{startPromptTask.firstStepTitle}」已分派給{' '}
                <strong className="text-slate-900">
                  {startPromptTask.firstToolName}（{startPromptTask.firstChannelLabel}）
                </strong>
                ，預估 {startPromptTask.estimatedMinutes} 分鐘。
              </p>
            </div>

            <div className="pt-2 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const title = startPromptTask.title;
                  setStartPromptTask(null);
                  showNotice(`已建立接力任務「${title}」，保留於今日排程待啟動。`);
                }}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap shrink-0"
              >
                稍後再開始
              </button>
              <button
                type="button"
                onClick={() => {
                  handleStartStep(startPromptTask.taskId, startPromptTask.firstStepId);
                  setSelectedTaskId(startPromptTask.taskId);
                  setSelectedStepId(startPromptTask.firstStepId);
                  setActiveTab('relay');
                  const title = startPromptTask.title;
                  setStartPromptTask(null);
                  showNotice(`已手動啟動「${title}」第 1 棒並進入執行中，預估完成時間已同步更新。`);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                手動逐棒啟動
              </button>
              <button
                type="button"
                onClick={() => {
                  const tid = startPromptTask.taskId;
                  setStartPromptTask(null);
                  void handleStartAutoRelay(tid);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg whitespace-nowrap shrink-0"
              >
                <FastForward className="w-3.5 h-3.5" />
                全自動接力執行到底
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
