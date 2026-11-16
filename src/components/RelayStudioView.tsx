import { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  FastForward,
  PauseCircle,
  Play,
  RotateCcw,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import type {
  AITool,
  AutoRelayStatus,
  ChannelType,
  LinkedAccount,
  RelayStep,
  RelayTask,
} from '../types';
import { buildToolLaunchUrl, getTaskProgressAndEta } from '../utils/scheduler';
import { getToolEffectiveSummary } from '../utils/toolCredits';

interface RelayStudioViewProps {
  tasks: RelayTask[];
  tools: AITool[];
  linkedAccounts: LinkedAccount[];
  currentDate: string;
  nowMs: number;
  selectedTaskId: string;
  selectedStepId: string;
  autoRelayStatus: AutoRelayStatus | null;
  onSelectTask: (taskId: string) => void;
  onSelectStep: (stepId: string) => void;
  onChangeStepTool: (taskId: string, stepId: string, newToolId: string) => void;
  onChangeStepChannel: (taskId: string, stepId: string, channel: ChannelType) => void;
  onStartStep: (taskId: string, stepId: string) => void;
  onUpdateStepOutput: (taskId: string, stepId: string, output: string) => void;
  onCompleteStep: (
    taskId: string,
    stepId: string,
    output: string,
    channel: ChannelType
  ) => void;
  onStashStep: (taskId: string, stepId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onStartAutoRelay: (taskId: string) => void;
  onStopAutoRelay: () => void;
  onAutoRunSingleStep: (taskId: string, stepId: string) => Promise<void>;
  onCloneTask: (taskId: string) => void;
}

const STATUS_LABELS: Record<RelayStep['status'], { text: string; className: string }> = {
  completed: { text: '已完成交棒', className: 'text-emerald-700' },
  in_progress: { text: '執行中', className: 'text-blue-700' },
  scheduled: { text: '今日已排程', className: 'text-slate-700' },
  pending: { text: '待排程', className: 'text-slate-500' },
  stashed: { text: '已暫存明日', className: 'text-amber-700' },
};

export function RelayStudioView({
  tasks,
  tools,
  linkedAccounts,
  currentDate,
  nowMs,
  selectedTaskId,
  selectedStepId,
  autoRelayStatus,
  onSelectTask,
  onSelectStep,
  onChangeStepTool,
  onChangeStepChannel,
  onStartStep,
  onUpdateStepOutput,
  onCompleteStep,
  onStashStep,
  onDeleteTask,
  onStartAutoRelay,
  onStopAutoRelay,
  onAutoRunSingleStep,
  onCloneTask,
}: RelayStudioViewProps) {
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'stashed' | 'completed'>('all');
  const [copied, setCopied] = useState(false);
  const [copiedDeliverable, setCopiedDeliverable] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isAutoStepping, setIsAutoStepping] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  const filteredTasks = tasks.filter((t) => {
    if (filterStatus === 'all') return true;
    if (filterStatus === 'active') return t.status === 'active' || t.status === 'scheduled';
    return t.status === filterStatus;
  });

  const activeTask =
    tasks.find((t) => t.id === selectedTaskId) ?? filteredTasks[0] ?? tasks[0] ?? null;

  const activeStep =
    activeTask?.steps.find((s) => s.id === selectedStepId) ??
    activeTask?.steps.find((s) => s.status !== 'completed') ??
    activeTask?.steps[0] ??
    null;

  const [draftOutput, setDraftOutput] = useState(activeStep?.output ?? '');

  useEffect(() => {
    setDraftOutput(activeStep?.output ?? '');
    setExecError(null);
  }, [activeStep?.id, activeStep?.output]);

  if (!activeTask) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
        <p className="text-sm font-medium text-slate-800">目前尚無任何接力任務</p>
        <p className="text-xs text-slate-500 mt-1">請點擊右上角「新增接力任務」建立多模型工作流。</p>
      </div>
    );
  }

  const assignedTool = tools.find((t) => t.id === activeStep?.assignedToolId);
  const toolSummary = assignedTool
    ? getToolEffectiveSummary(assignedTool, linkedAccounts)
    : null;
  const activeChannel: ChannelType =
    activeStep?.assignedChannel ??
    (toolSummary && !toolSummary.webAvailable && toolSummary.appAvailable ? 'app' : 'web');

  const previousCompletedSteps = activeTask.steps.filter(
    (s) => activeStep && s.order < activeStep.order && s.output.trim().length > 0
  );

  const buildFullHandoffPrompt = () => {
    if (!activeStep) return '';
    const contextBlock =
      previousCompletedSteps.length > 0
        ? previousCompletedSteps
            .map((prev) => {
              const prevToolName = tools.find((t) => t.id === prev.assignedToolId)?.name ?? prev.assignedToolId;
              const prevCh = prev.assignedChannel === 'app' ? 'App 版' : '網頁版';
              return `【來自第 ${prev.order} 棒 (${prevToolName} · ${prevCh}) 之產出】\n${prev.output}`;
            })
            .join('\n\n')
        : '（此為第 1 棒，無前序上下文）';

    const channelLabel = activeChannel === 'app' ? 'App 版' : '網頁版';
    return `總目標：${activeTask.title}\n目標說明：${activeTask.goal}\n\n${contextBlock}\n\n【本步驟 (${assignedTool?.name ?? activeStep.assignedToolId} · ${channelLabel}) 任務指令】\n${activeStep.promptTemplate}`;
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildFullHandoffPrompt());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setExecError('瀏覽器拒絕剪貼簿存取，請手動選取下方提示詞複製。');
    }
  };

  const handleAiAssistExecute = async () => {
    if (!activeStep) return;
    if (activeStep.status !== 'completed' && activeStep.status !== 'in_progress') {
      onStartStep(activeTask.id, activeStep.id);
    }
    setIsExecuting(true);
    setExecError(null);
    try {
      const response = await fetch('/api/relay/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskTitle: activeTask.title,
          taskGoal: activeTask.goal,
          stepTitle: activeStep.title,
          capabilityTag: activeStep.capabilityTag,
          assignedToolName: `${assignedTool?.name ?? activeStep.assignedToolId} (${
            activeChannel === 'app' ? 'App 版' : '網頁版'
          })`,
          toolStrengths: assignedTool?.strengths ?? [],
          promptTemplate: activeStep.promptTemplate,
          previousOutputs: previousCompletedSteps.map((s) => ({
            stepTitle: s.title,
            toolName: tools.find((t) => t.id === s.assignedToolId)?.name ?? s.assignedToolId,
            channelLabel: s.assignedChannel === 'app' ? 'App 版' : '網頁版',
            output: s.output,
          })),
        }),
      });
      const data = (await response.json()) as { output?: string; error?: string };
      if (!response.ok || !data.output) {
        throw new Error(data.error ?? 'AI 接力生成失敗');
      }
      setDraftOutput(data.output);
      onUpdateStepOutput(activeTask.id, activeStep.id, data.output);
    } catch (error) {
      setExecError(error instanceof Error ? error.message : '執行步驟失敗');
    } finally {
      setIsExecuting(false);
    }
  };

  const handleOneClickStepAndHandoff = async () => {
    if (!activeStep) return;
    setIsAutoStepping(true);
    setExecError(null);
    try {
      await onAutoRunSingleStep(activeTask.id, activeStep.id);
    } catch (error) {
      setExecError(error instanceof Error ? error.message : '單步自動接力失敗');
    } finally {
      setIsAutoStepping(false);
    }
  };

  const handlePasteFromClipboardAndHandoff = async () => {
    if (!activeStep) return;
    setExecError(null);
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        setExecError('剪貼簿目前為空，請先複製外部 AI 的回覆結果再試一次。');
        return;
      }
      setDraftOutput(text);
      onCompleteStep(activeTask.id, activeStep.id, text, activeChannel);
    } catch {
      setExecError('瀏覽器未授權讀取剪貼簿，請改用 Ctrl+V 貼入下方文字框後點擊完成交棒。');
    }
  };

  const isThisTaskAutoRunning = autoRelayStatus?.taskId === activeTask.id;

  const channelRemaining = toolSummary
    ? activeChannel === 'app'
      ? toolSummary.appRemaining
      : toolSummary.webRemaining
    : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left 4 Cols: Task Queue Selector */}
      <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">接力任務清單</h2>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              共 {tasks.length} 項
            </span>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {[
              { id: 'all', label: '全部' },
              { id: 'active', label: '進行中' },
              { id: 'stashed', label: '已暫存' },
              { id: 'completed', label: '已結案' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterStatus(tab.id as typeof filterStatus)}
                className={`flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  filterStatus === tab.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-slate-100 max-h-[680px] overflow-y-auto">
          {filteredTasks.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">此篩選條件下無任務</div>
          ) : (
            filteredTasks.map((task) => {
              const eta = getTaskProgressAndEta(task, nowMs, currentDate);
              const isSelected = task.id === activeTask.id;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => {
                    onSelectTask(task.id);
                    const nextIncomplete =
                      task.steps.find((s) => s.status !== 'completed') ?? task.steps[0];
                    if (nextIncomplete) onSelectStep(nextIncomplete.id);
                  }}
                  className={`w-full text-left px-4 py-3.5 transition-colors space-y-1.5 ${
                    isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                    <span>
                      <strong className="text-slate-800">{task.priority}</strong>
                      <span className="mx-1.5" aria-hidden="true">·</span>
                      <span
                        className={
                          task.status === 'completed'
                            ? 'text-emerald-700 font-medium'
                            : eta.isRunning
                            ? 'text-blue-700 font-semibold'
                            : 'text-slate-500'
                        }
                      >
                        {task.status === 'completed'
                          ? '已結案'
                          : eta.isRunning
                          ? '執行中'
                          : '待接力'}
                      </span>
                      {task.daysCarriedOver > 0 && (
                        <>
                          <span className="mx-1.5" aria-hidden="true">·</span>
                          <span className="text-amber-700 font-medium">
                            跨日 +{task.daysCarriedOver}d
                          </span>
                        </>
                      )}
                    </span>
                    <span className="font-mono tabular-nums">
                      {eta.completedSteps}/{eta.totalSteps} 棒 · {eta.progressPct}%
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-slate-900 line-clamp-2">
                    {task.title}
                  </p>
                  <div className="w-full h-1 bg-slate-100 rounded-full overflow-hidden">
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
                  <p className="text-xs text-slate-500 font-mono tabular-nums truncate">
                    {eta.etaSummary}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Right 8 Cols: Active Pipeline Relay Workbench */}
      <section className="lg:col-span-8 space-y-5">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-semibold text-slate-800">{activeTask.priority}</span>
                <span aria-hidden="true">·</span>
                <span>建立於 {activeTask.createdDate}</span>
                <span aria-hidden="true">·</span>
                <span>目標日 {activeTask.deadlineDate}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">優先權重 {activeTask.carryoverScore}</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-900">{activeTask.title}</h2>
              <p className="text-sm text-slate-600 leading-relaxed">{activeTask.goal}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activeTask.status !== 'completed' ? (
                isThisTaskAutoRunning ? (
                  <button
                    type="button"
                    onClick={onStopAutoRelay}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <Square className="w-3.5 h-3.5" />
                    暫停全自動接力
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onStartAutoRelay(activeTask.id)}
                    disabled={Boolean(autoRelayStatus)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    全自動接力執行到底
                  </button>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => onCloneTask(activeTask.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  再執行一次
                </button>
              )}

              <button
                type="button"
                onClick={() => onDeleteTask(activeTask.id)}
                aria-label="刪除任務"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                移除任務
              </button>
            </div>
          </div>

          {isThisTaskAutoRunning && autoRelayStatus && (
            <div className="px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs text-blue-900">
              <span className="font-medium">
                {autoRelayStatus.phase === 'finalizing'
                  ? '全自動接力：所有步驟已完成，正在自動彙整最終交付成果...'
                  : `全自動接力進行中（第 ${autoRelayStatus.currentStepOrder} / ${autoRelayStatus.totalSteps} 棒 · ${autoRelayStatus.currentToolName}），完成每步後會自動保存進度與交棒...`}
              </span>
              <span className="font-mono tabular-nums text-blue-700">免手動複製貼上</span>
            </div>
          )}

          {autoRelayStatus?.taskId === activeTask.id && autoRelayStatus.error && (
            <div className="px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {autoRelayStatus.error}
            </div>
          )}

          {activeTask.autoStashReason && (
            <div className="px-3.5 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900">
              排程備註：{activeTask.autoStashReason}
            </div>
          )}

          {/* Task Progress Bar & ETA Summary */}
          {(() => {
            const taskEta = getTaskProgressAndEta(activeTask, nowMs, currentDate);
            return (
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800">目前任務進度</span>
                    <span
                      className={`font-semibold ${
                        activeTask.status === 'completed'
                          ? 'text-emerald-700'
                          : isThisTaskAutoRunning || isExecuting || isAutoStepping || taskEta.isRunning
                          ? 'text-blue-700'
                          : 'text-slate-600'
                      }`}
                    >
                      {activeTask.status === 'completed'
                        ? '全部已完成'
                        : isThisTaskAutoRunning
                        ? '全自動接力執行中'
                        : isExecuting || isAutoStepping
                        ? 'AI 正在執行步驟產出...'
                        : taskEta.isRunning
                        ? '執行中'
                        : '已排程待執行'}
                    </span>
                  </div>
                  <div className="font-mono tabular-nums text-slate-700">
                    <span className="font-semibold">{taskEta.progressPct}%</span>
                    <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
                    <span>{taskEta.etaSummary}</span>
                  </div>
                </div>
                <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      activeTask.status === 'completed'
                        ? 'bg-emerald-600'
                        : isThisTaskAutoRunning || isExecuting || isAutoStepping || taskEta.isRunning
                        ? 'bg-blue-600'
                        : 'bg-slate-800'
                    }`}
                    style={{ width: `${taskEta.progressPct}%` }}
                  />
                </div>
              </div>
            );
          })()}

          {/* Final Deliverable Banner when completed */}
          {activeTask.status === 'completed' && (
            <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-lg space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-emerald-950">
                  最終整合交付成果（已永久保存於任務歷史）
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const content =
                        activeTask.finalDeliverable?.trim() ||
                        activeTask.steps
                          .map((s) => `## 第 ${s.order} 棒｜${s.title}\n${s.output}`)
                          .join('\n\n');
                      try {
                        await navigator.clipboard.writeText(content);
                        setCopiedDeliverable(true);
                        setTimeout(() => setCopiedDeliverable(false), 1800);
                      } catch {
                        setExecError('瀏覽器拒絕剪貼簿存取');
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-900 bg-white border border-emerald-200 hover:bg-emerald-100 rounded-md whitespace-nowrap"
                  >
                    {copiedDeliverable ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        已複製最終成品
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        複製完整成品
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const content =
                        activeTask.finalDeliverable?.trim() ||
                        activeTask.steps
                          .map((s) => `## 第 ${s.order} 棒｜${s.title}\n${s.output}`)
                          .join('\n\n');
                      const blob = new Blob([`# ${activeTask.title}\n\n${content}`], {
                        type: 'text/markdown;charset=utf-8',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${activeTask.title.slice(0, 30) || 'relayflow-output'}.md`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-900 bg-white border border-emerald-200 hover:bg-emerald-100 rounded-md whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    下載 Markdown
                  </button>
                </div>
              </div>
              {activeTask.finalDeliverable && (
                <div className="p-3.5 bg-white border border-emerald-200/80 rounded-lg text-xs text-slate-800 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">
                  {activeTask.finalDeliverable}
                </div>
              )}
            </div>
          )}

          {/* Horizontal Relay Chain Steps */}
          <div className="pt-2 border-t border-slate-100">
            <p className="text-xs font-medium text-slate-500 mb-3">
              接力執行鏈（點擊各步驟查看交棒脈絡與指派模型 / 執行端）
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
              {activeTask.steps.map((step) => {
                const tool = tools.find((t) => t.id === step.assignedToolId);
                const isSelected = activeStep?.id === step.id;
                const statusInfo = STATUS_LABELS[step.status];
                const chLabel = step.assignedChannel === 'app' ? 'App' : 'Web';

                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => onSelectStep(step.id)}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                      isSelected
                        ? 'border-blue-600 bg-blue-50/60'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono tabular-nums text-slate-500">
                        第 {step.order} 棒 · {chLabel}
                      </span>
                      <span className={`font-medium ${statusInfo.className}`}>
                        {statusInfo.text}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs font-semibold text-slate-900 line-clamp-1">
                      {tool?.name ?? step.assignedToolId}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">{step.title}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Active Step Execution & Context Handoff Workspace */}
        {activeStep && (
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-mono tabular-nums">第 {activeStep.order} 棒</span>
                  <span aria-hidden="true">·</span>
                  <span>能力定位：{activeStep.capabilityTag}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    預估 {activeStep.estimatedMinutes} 分鐘
                  </span>
                </div>
                <h3 className="text-base font-semibold text-slate-900 mt-1">
                  {activeStep.title}
                </h3>
                <p className="text-xs text-slate-500 mt-1">分流說明：{activeStep.routingNote}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <select
                  id="step-tool-select"
                  aria-label="指派工具"
                  value={activeStep.assignedToolId}
                  onChange={(e) =>
                    onChangeStepTool(activeTask.id, activeStep.id, e.target.value)
                  }
                  disabled={activeStep.status === 'completed'}
                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                >
                  {tools.map((t) => {
                    const s = getToolEffectiveSummary(t, linkedAccounts);
                    return (
                      <option key={t.id} value={t.id} disabled={!t.enabled}>
                        {t.name}（剩 {s.totalRemaining}/{s.totalLimit}）
                      </option>
                    );
                  })}
                </select>

                <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    disabled={activeStep.status === 'completed' || !toolSummary?.webAvailable}
                    onClick={() => onChangeStepChannel(activeTask.id, activeStep.id, 'web')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 whitespace-nowrap ${
                      activeChannel === 'web'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    網頁版
                  </button>
                  <button
                    type="button"
                    disabled={activeStep.status === 'completed' || !toolSummary?.appAvailable}
                    onClick={() => onChangeStepChannel(activeTask.id, activeStep.id, 'app')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 whitespace-nowrap ${
                      activeChannel === 'app'
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    App 版
                  </button>
                </div>
              </div>
            </div>

            {/* Incoming Handoff Context from Previous Steps */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-700">
                  承接前序接力上下文 ({previousCompletedSteps.length} 份已交付產出)
                </h4>
                {assignedTool && (() => {
                  const fullPrompt = buildFullHandoffPrompt();
                  const launchTarget = buildToolLaunchUrl(
                    assignedTool.id,
                    assignedTool.officialUrl,
                    fullPrompt
                  );
                  return (
                    <a
                      href={launchTarget.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => {
                        if (activeStep.status !== 'completed') {
                          onStartStep(activeTask.id, activeStep.id);
                        }
                        if (navigator.clipboard && fullPrompt) {
                          void navigator.clipboard.writeText(fullPrompt).catch(() => {});
                        }
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                    >
                      {launchTarget.prefilledInUrl
                        ? `自動帶入提示詞開啟 ${assignedTool.name}`
                        : `複製提示詞並開啟 ${assignedTool.name}`}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  );
                })()}
              </div>

              {previousCompletedSteps.length === 0 ? (
                <div className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-500">
                  {activeStep.order === 1
                    ? '此為接力任務的首棒步驟，將直接依據總目標開始執行。'
                    : '前序步驟尚未填入產出；完成上一步後，其輸出會自動彙整至此處作為交棒脈絡。'}
                </div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                  {previousCompletedSteps.map((prev) => {
                    const prevTool = tools.find((t) => t.id === prev.assignedToolId);
                    const prevChannelText = prev.assignedChannel === 'app' ? 'App 版' : '網頁版';
                    return (
                      <div key={prev.id} className="text-xs text-slate-700 space-y-1 pb-2.5 border-b border-slate-200/80 last:border-none last:pb-0">
                        <div className="font-semibold text-slate-900">
                          第 {prev.order} 棒 · {prevTool?.name ?? prev.assignedToolId}（{prevChannelText} · {prev.title}）
                        </div>
                        <p className="whitespace-pre-wrap text-slate-600 leading-relaxed">
                          {prev.output}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Ready-to-copy Handoff Prompt */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-slate-700">本步驟執行與交棒提示詞</h4>
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      已複製完整交棒提示詞
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      複製含上下文提示詞
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3.5 bg-slate-900 text-slate-100 rounded-lg text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
                {buildFullHandoffPrompt()}
              </pre>
            </div>

            {/* Step Output Editor & Execution Buttons */}
            <div className="space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label htmlFor="step-output-area" className="text-xs font-semibold text-slate-700">
                  步驟產出成果（可自動化直接交棒，或一鍵從外部貼回）
                </label>

                <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
                  <button
                    type="button"
                    onClick={() => void handlePasteFromClipboardAndHandoff()}
                    disabled={isExecuting || isAutoStepping || activeStep.status === 'completed'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5" />
                    貼回剪貼簿並直接交棒
                  </button>

                  <button
                    type="button"
                    onClick={handleAiAssistExecute}
                    disabled={isExecuting || isAutoStepping || activeStep.status === 'completed'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Wand2 className="w-3.5 h-3.5" />
                    {isExecuting ? '生成預演中...' : '僅產生草稿預覽'}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleOneClickStepAndHandoff()}
                    disabled={isExecuting || isAutoStepping || activeStep.status === 'completed'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <FastForward className="w-3.5 h-3.5" />
                    {isAutoStepping ? '自動執行交棒中...' : '一鍵執行並直接交棒下一步'}
                  </button>
                </div>
              </div>

              {execError && (
                <div className="px-3.5 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  {execError}
                </div>
              )}

              <textarea
                id="step-output-area"
                rows={6}
                value={draftOutput}
                onChange={(e) => {
                  setDraftOutput(e.target.value);
                  onUpdateStepOutput(activeTask.id, activeStep.id, e.target.value);
                }}
                placeholder="貼上 Grok、Leonardo、Copilot、Bixby、Claude 或 AI Studio 產出的結果，或點擊上方「工作台 AI 輔助預演產出」自動填入..."
                className="w-full p-3.5 text-sm text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 leading-relaxed"
              />

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <span>
                    執行端：{assignedTool?.name}（{activeChannel === 'app' ? 'App 版' : '網頁版'}）· 消耗{' '}
                    <span className="font-mono tabular-nums font-semibold text-slate-800">
                      {activeStep.creditCost} {assignedTool?.unitLabel ?? 'Credits'}
                    </span>
                    （此通道剩餘{' '}
                    <span
                      className={`font-mono tabular-nums font-semibold ${
                        channelRemaining < activeStep.creditCost
                          ? 'text-red-600'
                          : 'text-emerald-700'
                      }`}
                    >
                      {channelRemaining}
                    </span>
                    ）
                  </span>
                  {activeStep.status !== 'completed' &&
                    channelRemaining < activeStep.creditCost &&
                    toolSummary &&
                    !toolSummary.isSharedQuota &&
                    ((activeChannel === 'web' &&
                      toolSummary.appAvailable &&
                      toolSummary.appRemaining >= activeStep.creditCost) ||
                      (activeChannel === 'app' &&
                        toolSummary.webAvailable &&
                        toolSummary.webRemaining >= activeStep.creditCost)) && (
                      <button
                        type="button"
                        onClick={() =>
                          onChangeStepChannel(
                            activeTask.id,
                            activeStep.id,
                            activeChannel === 'web' ? 'app' : 'web'
                          )
                        }
                        className="text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
                      >
                        切換至{activeChannel === 'web' ? 'App 版' : '網頁版'}剩餘額度 (
                        {activeChannel === 'web'
                          ? toolSummary.appRemaining
                          : toolSummary.webRemaining}
                        )
                      </button>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  {activeStep.status !== 'completed' && activeStep.status !== 'in_progress' && (
                    <button
                      type="button"
                      onClick={() => onStartStep(activeTask.id, activeStep.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      標記為執行中
                    </button>
                  )}

                  {activeStep.status !== 'completed' && activeStep.status !== 'stashed' && (
                    <button
                      type="button"
                      onClick={() => onStashStep(activeTask.id, activeStep.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <PauseCircle className="w-3.5 h-3.5" />
                      暫存至明日
                    </button>
                  )}

                  {activeStep.status === 'completed' ? (
                    <span className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg whitespace-nowrap shrink-0">
                      <CheckCircle2 className="w-4 h-4" />
                      已完成並交棒至下一步
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        onCompleteStep(
                          activeTask.id,
                          activeStep.id,
                          draftOutput.trim() ||
                            `已完成「${activeStep.title}」（由 ${
                              assignedTool?.name ?? activeStep.assignedToolId
                            } ${activeChannel === 'app' ? 'App 版' : '網頁版'}執行）`,
                          activeChannel
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <Play className="w-3.5 h-3.5" />
                      完成此步並扣額交棒
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
