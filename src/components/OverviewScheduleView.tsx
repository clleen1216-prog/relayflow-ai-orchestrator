import { ArrowRight, CalendarClock, Layers, RefreshCw, Sparkles } from 'lucide-react';
import type {
  AITool,
  LinkedAccount,
  RelayStep,
  RelayTask,
  RoutingMode,
  WorkspaceState,
} from '../types';
import {
  getLocalDateStr,
  getLocalTimeStr,
  getTaskProgressAndEta,
} from '../utils/scheduler';
import { getToolEffectiveSummary } from '../utils/toolCredits';

interface OverviewScheduleViewProps {
  state: WorkspaceState;
  nowMs: number;
  linkedAccounts: LinkedAccount[];
  onChangeRoutingMode: (mode: RoutingMode) => void;
  onChangeTimeBudget: (minutes: number) => void;
  onRunAutoSchedule: () => void;
  onSelectTaskStep: (taskId: string, stepId: string) => void;
  onNavigateTab: (tab: 'overview' | 'relay' | 'credits' | 'carryover' | 'accounts' | 'export') => void;
}

interface TimelineEntry {
  task: RelayTask;
  step: RelayStep;
  tool: AITool | undefined;
}

export function OverviewScheduleView({
  state,
  nowMs,
  linkedAccounts,
  onChangeRoutingMode,
  onChangeTimeBudget,
  onRunAutoSchedule,
  onSelectTaskStep,
  onNavigateTab,
}: OverviewScheduleViewProps) {
  const enabledTools = state.tools.filter((t) => t.enabled);

  let totalLimit = 0;
  let totalUsed = 0;
  let appBonusLimit = 0;

  for (const t of enabledTools) {
    const s = getToolEffectiveSummary(t, linkedAccounts);
    totalLimit += s.totalLimit;
    totalUsed += s.totalUsed;
    if (s.appAvailable && !s.isSharedQuota) {
      appBonusLimit += s.appLimit;
    }
  }

  const totalRemaining = Math.max(0, totalLimit - totalUsed);

  const scheduledEntries: TimelineEntry[] = [];
  const stashedEntries: TimelineEntry[] = [];
  let reroutedCount = 0;

  for (const task of state.tasks) {
    for (const step of task.steps) {
      const tool = state.tools.find((t) => t.id === step.assignedToolId);
      if (
        (step.assignedToolId !== step.preferredToolId || step.assignedChannel === 'app') &&
        step.status !== 'completed'
      ) {
        reroutedCount += 1;
      }
      if (step.status === 'scheduled' || step.status === 'in_progress') {
        scheduledEntries.push({ task, step, tool });
      } else if (step.status === 'stashed') {
        stashedEntries.push({ task, step, tool });
      }
    }
  }

  scheduledEntries.sort((a, b) =>
    (a.step.scheduledSlot ?? '').localeCompare(b.step.scheduledSlot ?? '')
  );

  const scheduledMinutes = scheduledEntries.reduce((sum, e) => sum + e.step.estimatedMinutes, 0);
  const stashedTasksCount = state.tasks.filter((t) => t.status === 'stashed').length;

  const routingModes: Array<{ id: RoutingMode; label: string; hint: string }> = [
    { id: 'strength_first', label: '強項優先', hint: '嚴格鎖定最適模型，額度不足則暫存' },
    { id: 'quota_balanced', label: '免費額度均衡', hint: '高耗盡風險工具自動分流至充沛免費模型或 App 通道' },
    { id: 'urgency_first', label: '截止與跨日優先', hint: '優先確保 P1 與昨日暫存任務今日收尾' },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Summary Strip */}
      <section aria-label="今日資源與排程摘要" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">今日可用免費額度總計</p>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold tracking-tight text-slate-900 font-mono tabular-nums">
              {totalRemaining} <span className="text-sm font-normal text-slate-500">/ {totalLimit}</span>
            </span>
            <span className="text-xs font-medium text-emerald-700">
              {totalLimit > 0 ? Math.round((totalRemaining / totalLimit) * 100) : 0}% 剩餘
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            含 App 版獨立加成 +{appBonusLimit} · 跨 {enabledTools.length} 項工具
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">今日自動排程接力步驟</p>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold tracking-tight text-slate-900 font-mono tabular-nums">
              {scheduledEntries.length} <span className="text-sm font-normal text-slate-500">步</span>
            </span>
            <span className="text-xs font-medium text-blue-700 font-mono tabular-nums">
              {scheduledMinutes} / {state.dailyTimeBudgetMinutes} 分鐘
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            含上下文交棒緩衝 · 今日工時佔比 {Math.min(100, Math.round((scheduledMinutes / state.dailyTimeBudgetMinutes) * 100))}%
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">雙端 / 智慧分流調度</p>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold tracking-tight text-slate-900 font-mono tabular-nums">
              {reroutedCount} <span className="text-sm font-normal text-slate-500">次</span>
            </span>
            <span className="text-xs font-medium text-slate-700">
              {routingModes.find((m) => m.id === state.routingMode)?.label}
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            包含跨模型轉移與 Web → App 版獨立池切換
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">暫存待隔日重排任務</p>
          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold tracking-tight text-slate-900 font-mono tabular-nums">
              {stashedTasksCount} <span className="text-sm font-normal text-slate-500">項任務</span>
            </span>
            <button
              type="button"
              onClick={() => onNavigateTab('carryover')}
              className="text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline whitespace-nowrap shrink-0"
            >
              檢視跨日佇列
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {stashedEntries.length} 個步驟已保存脈絡，明日重置後優先執行
          </p>
        </div>
      </section>

      {/* Task Progress Bars & Estimated Completion Time Strip */}
      <section aria-label="任務進度條與預估完成時間" className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">
            目前任務執行狀態、進度條與預估完成時間
          </h2>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            執行中 {state.tasks.filter((t) => getTaskProgressAndEta(t, nowMs, state.currentDate).isRunning).length} 項 · 總計 {state.tasks.length} 項任務
          </span>
        </div>

        {state.tasks.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium text-slate-700">目前尚無任何接力任務</p>
            <p className="mt-1 text-xs text-slate-500">
              請點擊右上角「新增接力任務」建立您的第一個多 AI 接力流程，系統將自動評估免費額度並即時詢問是否開始執行。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-100">
            {state.tasks.map((task) => {
              const eta = getTaskProgressAndEta(task, nowMs, state.currentDate);
              const activeStep =
                task.steps.find((s) => s.status === 'in_progress') ??
                task.steps.find((s) => s.status !== 'completed') ??
                task.steps[0];
              const activeTool = activeStep
                ? state.tools.find((t) => t.id === activeStep.assignedToolId)
                : undefined;

              return (
                <div
                  key={task.id}
                  className="px-5 py-4 border-b border-slate-100 space-y-2.5 flex flex-col justify-between"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-x-2 text-xs">
                        <span
                          className={`font-semibold ${
                            task.status === 'completed'
                              ? 'text-emerald-700'
                              : eta.isRunning
                              ? 'text-blue-700'
                              : task.status === 'stashed'
                              ? 'text-amber-700'
                              : 'text-slate-600'
                          }`}
                        >
                          {task.status === 'completed'
                            ? '已結案'
                            : eta.isRunning
                            ? '執行中'
                            : task.status === 'stashed'
                            ? '部分暫存明日'
                            : '已排程待啟動'}
                        </span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-600">
                          {eta.completedSteps}/{eta.totalSteps} 棒 ({eta.progressPct}%)
                        </span>
                        {activeStep && task.status !== 'completed' && (
                          <>
                            <span className="text-slate-300" aria-hidden="true">·</span>
                            <span className="text-slate-500 truncate max-w-[200px]">
                              目前：{activeTool?.name ?? activeStep.assignedToolId}（
                              {activeStep.assignedChannel === 'app' ? 'App 版' : '網頁版'}）
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-slate-900 truncate">{task.title}</p>
                    </div>

                    {activeStep && (
                      <button
                        type="button"
                        onClick={() => onSelectTaskStep(task.id, activeStep.id)}
                        className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                      >
                        {eta.isRunning ? '查看執行' : '進入接力'}
                      </button>
                    )}
                  </div>

                  <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-200 ${
                        task.status === 'completed'
                          ? 'bg-emerald-600'
                          : eta.isRunning
                          ? 'bg-blue-600'
                          : 'bg-slate-700'
                      }`}
                      style={{ width: `${eta.progressPct}%` }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                    <span>{eta.etaSummary}</span>
                    <span>
                      已耗 {eta.completedMinutes} / {eta.totalMinutes} 分鐘
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Auto-Scheduling & Routing Control Bar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">自動排程與任務分流策略</h2>
            <p className="text-xs text-slate-500">
              {routingModes.find((m) => m.id === state.routingMode)?.hint}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="分流策略選擇">
              {routingModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => onChangeRoutingMode(mode.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    state.routingMode === mode.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-600">
              <label htmlFor="budget-select" className="whitespace-nowrap">
                每日工時上限
              </label>
              <select
                id="budget-select"
                value={state.dailyTimeBudgetMinutes}
                onChange={(e) => onChangeTimeBudget(Number(e.target.value))}
                className="bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={120}>120 分鐘 (2h)</option>
                <option value={180}>180 分鐘 (3h)</option>
                <option value={240}>240 分鐘 (4h)</option>
                <option value={360}>360 分鐘 (6h)</option>
              </select>
            </div>

            <button
              type="button"
              onClick={onRunAutoSchedule}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              一鍵重排與分流
            </button>
          </div>
        </div>
      </section>

      {/* Main 2-Column Workspace Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left 7 Cols: Today's Auto-Scheduled Relay Timeline */}
        <section className="xl:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">今日 AI 接力自動排程時間軸</h2>
            </div>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              {state.currentDate <= getLocalDateStr(nowMs)
                ? `${state.currentDate} ${getLocalTimeStr(nowMs, true)} · 即時時間起算`
                : `${state.currentDate} · 預排 09:00 起算`}
            </span>
          </div>

          {scheduledEntries.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-slate-700">目前今日時間軸沒有待執行步驟</p>
              <p className="mt-1 text-xs text-slate-500">
                所有任務可能已完成、或因免費額度不足而暫存至明日。您可登入個人帳號疊加額度或調整排程策略。
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {scheduledEntries.map(({ task, step, tool }) => {
                const isRerouted = step.assignedToolId !== step.preferredToolId;
                const channelText = step.assignedChannel === 'app' ? 'App 版' : '網頁版';
                return (
                  <div
                    key={step.id}
                    className="px-5 py-3.5 hover:bg-slate-50 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                        <span className="font-mono tabular-nums font-medium text-slate-800">
                          {step.scheduledSlot ?? '待排程'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-semibold ${
                            step.status === 'in_progress' ? 'text-blue-700' : 'text-slate-600'
                          }`}
                        >
                          {step.status === 'in_progress' ? '執行中' : '已排程'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-slate-700">{task.priority}</span>
                        {task.daysCarriedOver > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-amber-700 font-medium">
                              跨日延續第 {task.daysCarriedOver} 天
                            </span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="truncate max-w-xs">{task.title}</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono tabular-nums text-slate-400">
                          0{step.order}.
                        </span>
                        <p className="text-sm font-medium text-slate-900 truncate">{step.title}</p>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        <span className="font-medium text-blue-700">
                          {tool?.name ?? step.assignedToolId}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-medium text-slate-700">{channelText}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          -{step.creditCost} {tool?.unitLabel ?? 'Credits'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className={isRerouted ? 'text-amber-700' : 'text-slate-500'}>
                          {step.routingNote}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onSelectTaskStep(task.id, step.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
                    >
                      執行接力
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {stashedEntries.length > 0 && (
            <div className="border-t border-slate-200 bg-slate-50/70 px-5 py-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-amber-800">
                  已自動暫存至明日的接力步驟 ({stashedEntries.length})
                </span>
                <button
                  type="button"
                  onClick={() => onNavigateTab('carryover')}
                  className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                >
                  設定隔日重排
                </button>
              </div>
              <div className="space-y-2">
                {stashedEntries.map(({ task, step, tool }) => (
                  <div
                    key={step.id}
                    className="flex items-center justify-between gap-3 text-xs text-slate-600 py-1.5 border-b border-slate-200/70 last:border-none"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800">{task.title}</span>
                      <span className="mx-1.5 text-slate-400">/</span>
                      <span>
                        步驟 {step.order}：{step.title}
                      </span>
                      <span className="mx-1.5 text-slate-400">·</span>
                      <span className="text-amber-700">{step.routingNote}</span>
                    </div>
                    <span className="font-mono text-slate-500 whitespace-nowrap shrink-0">
                      {tool?.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Right 5 Cols: Daily AI Free Credit Snapshot (Web + App) */}
        <section className="xl:col-span-5 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-slate-500" />
              <h2 className="text-base font-semibold text-slate-900">各大 AI 每日額度監控（含 Web/App）</h2>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('credits')}
              className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
            >
              雙端資源評估
            </button>
          </div>

          <div className="divide-y divide-slate-100 max-h-[640px] overflow-y-auto">
            {state.tools.map((tool) => {
              const s = getToolEffectiveSummary(tool, linkedAccounts);
              const pctRemaining =
                s.totalLimit > 0 ? Math.round((s.totalRemaining / s.totalLimit) * 100) : 0;

              let statusText = '額度充沛';
              let statusColor = 'text-emerald-700';
              let barColor = 'bg-emerald-600';

              if (!tool.enabled) {
                statusText = '已停用';
                statusColor = 'text-slate-400';
                barColor = 'bg-slate-300';
              } else if (s.totalRemaining < tool.costPerStep) {
                statusText = '今日已耗盡';
                statusColor = 'text-red-600';
                barColor = 'bg-red-500';
              } else if (pctRemaining <= 35) {
                statusText = '額度吃緊';
                statusColor = 'text-amber-700';
                barColor = 'bg-amber-500';
              }

              return (
                <div key={tool.id} className="px-5 py-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900 truncate">
                          {tool.name}
                        </span>
                        {s.accountCount > 1 && (
                          <span className="text-xs font-mono text-blue-700 shrink-0">
                            ×{s.accountCount}帳號
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">
                        {s.webAvailable ? `Web 剩 ${s.webRemaining}` : '無 Web'}
                        <span className="mx-1.5" aria-hidden="true">·</span>
                        {s.appAvailable
                          ? s.isSharedQuota
                            ? 'App 共享池'
                            : `App 剩 ${s.appRemaining}`
                          : '無 App'}
                      </p>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-sm font-mono tabular-nums font-semibold text-slate-900">
                        {s.totalRemaining}{' '}
                        <span className="text-xs font-normal text-slate-400">
                          / {s.totalLimit}
                        </span>
                      </div>
                      <div className={`text-xs font-medium ${statusColor}`}>{statusText}</div>
                    </div>
                  </div>

                  <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${barColor} transition-all duration-200`}
                      style={{ width: `${tool.enabled ? pctRemaining : 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span>登入個人帳號並綁定多組帳號可立即擴充各 AI 每日額度上限。</span>
            </div>
            <button
              type="button"
              onClick={() => onNavigateTab('accounts')}
              className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
            >
              帳號擴充
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
