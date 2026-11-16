import { useState } from 'react';
import {
  ArrowRight,
  CalendarCheck2,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  History,
  Layers,
  RotateCcw,
} from 'lucide-react';
import type { WorkspaceState } from '../types';
import {
  addDaysToDateStr,
  computeTaskPriorityScore,
  getTaskProgressAndEta,
} from '../utils/scheduler';

interface CarryoverQueueViewProps {
  state: WorkspaceState;
  nowMs: number;
  onExecuteRollover: () => void;
  onOpenTask: (taskId: string) => void;
  onCloneTask: (taskId: string) => void;
}

function formatIsoTimeLabel(iso?: string): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export function CarryoverQueueView({
  state,
  nowMs,
  onExecuteRollover,
  onOpenTask,
  onCloneTask,
}: CarryoverQueueViewProps) {
  const [historyFilter, setHistoryFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);

  const nextDate = addDaysToDateStr(state.currentDate, 1);

  const completedToday = state.tasks.filter(
    (t) => t.status === 'completed' || t.steps.every((s) => s.status === 'completed')
  );
  const unfinishedToday = state.tasks.filter(
    (t) => t.status !== 'completed' && !t.steps.every((s) => s.status === 'completed')
  );

  const filteredHistoryTasks = [...state.tasks]
    .filter((task) => {
      const isDone =
        task.status === 'completed' || task.steps.every((s) => s.status === 'completed');
      if (historyFilter === 'completed') return isDone;
      if (historyFilter === 'active') return !isDone;
      return true;
    })
    .sort((a, b) => {
      const aTs = a.updatedAt ? Date.parse(a.updatedAt) || 0 : 0;
      const bTs = b.updatedAt ? Date.parse(b.updatedAt) || 0 : 0;
      return bTs - aTs;
    });

  // Preview next-day re-prioritization order
  const previewQueue = unfinishedToday
    .map((task) => {
      const completedSteps = task.steps.filter((s) => s.status === 'completed').length;
      const nextDays = task.daysCarriedOver + 1;
      const simulatedTask = { ...task, daysCarriedOver: nextDays };
      const nextScore = computeTaskPriorityScore(simulatedTask);
      const basePts = task.priority === 'P1' ? 75 : task.priority === 'P2' ? 50 : 25;
      const carryPts = nextDays * 18;
      const progressPts =
        task.steps.length > 0 ? Math.round((completedSteps / task.steps.length) * 20) : 0;

      return {
        task,
        completedSteps,
        nextDays,
        nextScore,
        breakdown: { basePts, carryPts, progressPts },
      };
    })
    .sort((a, b) => b.nextScore - a.nextScore);

  const handleCopyDeliverable = async (taskId: string) => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const text =
      task.finalDeliverable?.trim() ||
      task.steps
        .filter((s) => s.output.trim().length > 0)
        .map((s) => `## 第 ${s.order} 棒｜${s.title}\n${s.output}`)
        .join('\n\n---\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTaskId(taskId);
      setTimeout(() => setCopiedTaskId((curr) => (curr === taskId ? null : curr)), 1800);
    } catch {
      // Ignore clipboard denial
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Rollover Trigger */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1 max-w-2xl">
          <h2 className="text-lg font-semibold text-slate-900">
            歷史任務進度總檔與跨日重分配
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            所有任務每一步產出、執行模式與進度皆會即時寫入本機與雲端，避免執行途中遺失；跨日結算時亦會完整保留未完成步驟的上下文並自動調升隔日優先順序。
          </p>
        </div>

        <button
          type="button"
          onClick={onExecuteRollover}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 self-start lg:self-center"
        >
          <CalendarCheck2 className="w-4 h-4" />
          執行日終結算並進入明日 ({nextDate})
        </button>
      </div>

      {/* Full Task History & Progress Archive */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-slate-500" />
            <h3 className="text-base font-semibold text-slate-900">
              歷史任務與執行進度紀錄 ({state.tasks.length})
            </h3>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto">
            {[
              { id: 'all', label: `全部 (${state.tasks.length})` },
              { id: 'active', label: `進行 / 待續 (${unfinishedToday.length})` },
              { id: 'completed', label: `已結案歷史 (${completedToday.length})` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setHistoryFilter(tab.id as typeof historyFilter)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  historyFilter === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredHistoryTasks.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            此篩選條件下尚無任務紀錄，建立並執行接力任務後，每一步進度與產出都會自動保存於此。
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredHistoryTasks.map((task) => {
              const eta = getTaskProgressAndEta(task, nowMs, state.currentDate);
              const isExpanded = Boolean(expandedTaskIds[task.id]);
              const hasAnyOutput =
                Boolean(task.finalDeliverable?.trim()) ||
                task.steps.some((s) => s.output.trim().length > 0);
              const isDone =
                task.status === 'completed' || task.steps.every((s) => s.status === 'completed');

              return (
                <div key={task.id} className="px-5 py-4 space-y-3">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                        <span
                          className={`font-semibold ${
                            isDone
                              ? 'text-emerald-700'
                              : eta.isRunning
                              ? 'text-blue-700'
                              : task.status === 'stashed'
                              ? 'text-amber-700'
                              : 'text-slate-600'
                          }`}
                        >
                          {isDone
                            ? '已結案'
                            : eta.isRunning
                            ? '執行中'
                            : task.status === 'stashed'
                            ? '暫存待續'
                            : '已排程'}
                        </span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-700">
                          {eta.completedSteps}/{eta.totalSteps} 棒 ({eta.progressPct}%)
                        </span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span className="text-slate-500 font-mono tabular-nums">
                          建立 {task.createdDate}
                        </span>
                        {task.updatedAt && (
                          <>
                            <span className="text-slate-300" aria-hidden="true">·</span>
                            <span className="text-slate-500 font-mono tabular-nums">
                              最近更新 {formatIsoTimeLabel(task.updatedAt)}
                            </span>
                          </>
                        )}
                        {task.completedAt && (
                          <>
                            <span className="text-slate-300" aria-hidden="true">·</span>
                            <span className="text-emerald-700 font-mono tabular-nums">
                              完成於 {formatIsoTimeLabel(task.completedAt)}
                            </span>
                          </>
                        )}
                      </div>

                      <p className="text-sm font-semibold text-slate-900">{task.title}</p>
                      <p className="text-xs text-slate-500 line-clamp-1">{task.goal}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {hasAnyOutput && (
                        <button
                          type="button"
                          onClick={() => void handleCopyDeliverable(task.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap"
                        >
                          {copiedTaskId === task.id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              已複製成果
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              複製產出
                            </>
                          )}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => onCloneTask(task.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        再跑一次
                      </button>

                      <button
                        type="button"
                        onClick={() => onOpenTask(task.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg whitespace-nowrap"
                      >
                        {isDone ? '查看詳情' : '繼續執行'}
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setExpandedTaskIds((prev) => ({
                            ...prev,
                            [task.id]: !prev[task.id],
                          }))
                        }
                        aria-label={isExpanded ? '收合進度明細' : '展開進度明細'}
                        className="p-1.5 text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg"
                      >
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="space-y-1">
                    <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-200 ${
                          isDone
                            ? 'bg-emerald-600'
                            : eta.isRunning
                            ? 'bg-blue-600'
                            : 'bg-slate-700'
                        }`}
                        style={{ width: `${eta.progressPct}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between text-xs text-slate-500 font-mono tabular-nums">
                      <span>{eta.etaSummary}</span>
                      <span>
                        已耗 {eta.completedMinutes} / {eta.totalMinutes} 分鐘
                      </span>
                    </div>
                  </div>

                  {/* Expandable step outputs & timestamps */}
                  {isExpanded && (
                    <div className="pt-2 space-y-2.5 border-t border-slate-100">
                      {task.finalDeliverable && (
                        <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-lg space-y-1">
                          <div className="text-xs font-semibold text-emerald-900">
                            最終整合交付成果
                          </div>
                          <p className="text-xs text-emerald-950 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
                            {task.finalDeliverable}
                          </p>
                        </div>
                      )}

                      <div className="space-y-2">
                        {task.steps.map((step) => {
                          const toolName =
                            state.tools.find((t) => t.id === step.assignedToolId)?.name ??
                            step.assignedToolId;
                          const chLabel = step.assignedChannel === 'app' ? 'App 版' : '網頁版';
                          return (
                            <div
                              key={step.id}
                              className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1 text-xs"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-slate-900">
                                  第 {step.order} 棒｜{step.title}
                                </span>
                                <span className="font-mono tabular-nums text-slate-500">
                                  {toolName} ({chLabel})
                                  {step.executionMode === 'auto' ? ' · 全自動' : ''}
                                  {step.completedAt
                                    ? ` · 完成 ${formatIsoTimeLabel(step.completedAt)}`
                                    : step.startedAt
                                    ? ` · 啟動 ${formatIsoTimeLabel(step.startedAt)}`
                                    : ''}
                                </span>
                              </div>
                              {step.output ? (
                                <p className="text-slate-600 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                                  {step.output}
                                </p>
                              ) : (
                                <p className="text-slate-400">尚未產出內容（狀態：{step.status}）</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Tomorrow Priority Preview Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-slate-500" />
            <h3 className="text-base font-semibold text-slate-900">
              明日 ({nextDate}) 跨日優先順位預覽
            </h3>
          </div>
          <span className="text-xs text-slate-500 font-mono tabular-nums">
            將結案 {completedToday.length} 項 · 暫存接續 {previewQueue.length} 項
          </span>
        </div>

        {previewQueue.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            目前沒有未完成任務待跨日重排！點擊上方按鈕可直接重置各大 AI 免費額度並展開明日工作台。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[780px]">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 px-4">明日序位</th>
                  <th className="py-3 px-4">暫存任務名稱</th>
                  <th className="py-3 px-4">接力保留進度</th>
                  <th className="py-3 px-4 text-right">權重計算拆解</th>
                  <th className="py-3 px-4 text-right">隔日總權重</th>
                  <th className="py-3 px-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {previewQueue.map(({ task, completedSteps, nextDays, nextScore, breakdown }, idx) => (
                  <tr key={task.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-4 font-mono tabular-nums font-semibold text-slate-900">
                      #{idx + 1}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900">{task.title}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {task.priority} · 原建立 {task.createdDate} · 明日將為跨日第 {nextDays} 天
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-600">
                      <span className="font-mono tabular-nums font-medium text-slate-800">
                        已保存 {completedSteps} / {task.steps.length} 步產出
                      </span>
                      <div className="text-slate-400 mt-0.5 truncate max-w-xs">
                        待接續：{task.steps.find((s) => s.status !== 'completed')?.title ?? '收尾'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-right text-xs font-mono tabular-nums text-slate-600">
                      基礎 {breakdown.basePts} + 跨日 {breakdown.carryPts} + 進度 {breakdown.progressPts}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold text-blue-700">
                      {nextScore}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenTask(task.id)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                      >
                        檢視脈絡
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Carryover History Logs */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <History className="w-4 h-4 text-slate-500" />
          <h3 className="text-base font-semibold text-slate-900">跨日結算與優先重排歷史紀錄</h3>
        </div>

        <div className="divide-y divide-slate-100">
          {state.carryoverLogs.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">尚無跨日結算紀錄</div>
          ) : (
            state.carryoverLogs.map((log) => (
              <div key={log.id} className="px-5 py-4 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                  <span className="font-semibold text-slate-800">
                    {log.fromDate} → {log.toDate}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>結案 {log.completedCount} 項</span>
                  <span aria-hidden="true">·</span>
                  <span>暫存接力 {log.stashedCount} 項</span>
                </div>
                <p className="text-sm text-slate-700">{log.summary}</p>
                {log.reorderedTitles.length > 0 && (
                  <p className="text-xs text-slate-500">
                    重排順位：{log.reorderedTitles.join(' → ')}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
