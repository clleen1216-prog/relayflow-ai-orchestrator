import { useEffect, useState } from 'react';
import { Plus, Trash2, Wand2, X } from 'lucide-react';
import type { AITool, ChannelType, LinkedAccount, RelayTask, TaskPriority } from '../types';
import {
  buildLocalRelayPlan,
  draftsToRelaySteps,
  type PlannedStepDraft,
} from '../utils/localPlanner';
import { getToolEffectiveSummary } from '../utils/toolCredits';

interface CreateTaskModalProps {
  isOpen: boolean;
  currentDate: string;
  tools: AITool[];
  linkedAccounts: LinkedAccount[];
  onClose: () => void;
  onCreateTask: (task: RelayTask) => void;
}

export function CreateTaskModal({
  isOpen,
  currentDate,
  tools,
  linkedAccounts,
  onClose,
  onCreateTask,
}: CreateTaskModalProps) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('P1');
  const [deadlineDate, setDeadlineDate] = useState(currentDate);
  const [drafts, setDrafts] = useState<PlannedStepDraft[]>([]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setDeadlineDate(currentDate);
    }
  }, [isOpen, currentDate]);

  if (!isOpen) return null;

  const handleSmartPlan = async () => {
    if (!goal.trim()) {
      setPlanError('請先輸入任務目標描述');
      return;
    }
    setIsPlanning(true);
    setPlanError(null);

    try {
      const response = await fetch('/api/relay/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim() || undefined,
          goal: goal.trim(),
          priority,
          tools,
        }),
      });
      const data = (await response.json()) as {
        suggestedTitle?: string;
        steps?: PlannedStepDraft[];
        error?: string;
      };
      if (!response.ok || !data.steps || data.steps.length === 0) {
        throw new Error(data.error ?? '智慧拆解失敗');
      }
      if (!title.trim() && data.suggestedTitle) {
        setTitle(data.suggestedTitle);
      }
      const normalizedDrafts: PlannedStepDraft[] = data.steps.map((s) => ({
        ...s,
        preferredChannel:
          s.preferredChannel === 'app' || s.preferredChannel === 'web'
            ? s.preferredChannel
            : undefined,
      }));
      setDrafts(normalizedDrafts);
    } catch (error) {
      // Fall back gracefully while informing user
      const fallback = buildLocalRelayPlan(goal.trim(), tools);
      if (!title.trim()) setTitle(fallback.suggestedTitle);
      setDrafts(fallback.steps);
      setPlanError(
        `${error instanceof Error ? error.message : 'AI 連線失敗'} — 已自動切換為本地模型強項規則完成拆解，您可微調後儲存。`
      );
    } finally {
      setIsPlanning(false);
    }
  };

  const handleLocalPlan = () => {
    if (!goal.trim()) {
      setPlanError('請先輸入任務目標描述');
      return;
    }
    setPlanError(null);
    const local = buildLocalRelayPlan(goal.trim(), tools);
    if (!title.trim()) setTitle(local.suggestedTitle);
    setDrafts(local.steps);
  };

  const handleAddEmptyStep = () => {
    const defaultTool = tools.find((t) => t.enabled) ?? tools[0];
    setDrafts((prev) => [
      ...prev,
      {
        title: `接力步驟 ${prev.length + 1}`,
        capabilityTag: '通用處理',
        toolId: defaultTool?.id ?? 'gemini',
        estimatedMinutes: 20,
        promptTemplate: '承接前一步輸出，完成此階段交付項目。',
        routingReason: '手動新增接力步驟',
      },
    ]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;

    const finalDrafts =
      drafts.length > 0 ? drafts : buildLocalRelayPlan(goal.trim(), tools).steps;
    const taskId = `task-${Date.now()}`;
    const steps = draftsToRelaySteps(finalDrafts, tools, taskId);

    const newTask: RelayTask = {
      id: taskId,
      title: title.trim() || buildLocalRelayPlan(goal.trim(), tools).suggestedTitle,
      goal: goal.trim(),
      priority,
      deadlineDate,
      createdDate: currentDate,
      daysCarriedOver: 0,
      carryoverScore: priority === 'P1' ? 75 : priority === 'P2' ? 50 : 25,
      status: 'active',
      steps,
      autoStashReason: null,
    };

    onCreateTask(newTask);
    setTitle('');
    setGoal('');
    setDrafts([]);
    setPlanError(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-task-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 id="create-task-title" className="text-base font-semibold text-slate-900">
            建立多 AI 接力任務
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉視窗"
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                任務標題（可留白由 AI 自動歸納）
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例：2026 AI Agent 開源框架選型報告"
                className="w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">優先等級</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full px-2.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="P1">P1 緊急</option>
                  <option value="P2">P2 標準</option>
                  <option value="P3">P3 緩衝</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700">目標期限</label>
                <input
                  type="date"
                  value={deadlineDate}
                  onChange={(e) => setDeadlineDate(e.target.value)}
                  className="w-full px-2 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">
              任務最終目標描述
            </label>
            <textarea
              required
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="描述你想達成的成果，例如：「搜尋最新 RAG 評測基準，整理成技術比較表後潤飾為對內架構提案簡報並產出封面提示詞」"
              className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleSmartPlan}
              disabled={isPlanning}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <Wand2 className="w-3.5 h-3.5" />
              {isPlanning ? 'AI 正在拆解並匹配額度...' : 'AI 智慧拆解接力鏈'}
            </button>

            <button
              type="button"
              onClick={handleLocalPlan}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              依強項規則快速拆解
            </button>

            <button
              type="button"
              onClick={handleAddEmptyStep}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              手動新增步驟
            </button>
          </div>

          {planError && (
            <div className="px-3.5 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              {planError}
            </div>
          )}

          {drafts.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-slate-200">
              <div className="text-xs font-semibold text-slate-700">
                接力步驟預覽（儲存後將自動依今日免費額度排程分流）
              </div>
              <div className="space-y-2.5">
                {drafts.map((step, index) => {
                  const selectedTool = tools.find((t) => t.id === step.toolId) ?? tools[0];
                  const selectedSummary = selectedTool
                    ? getToolEffectiveSummary(selectedTool, linkedAccounts)
                    : null;
                  return (
                    <div
                      key={index}
                      className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
                        <span className="text-xs font-mono tabular-nums font-semibold text-slate-500 shrink-0">
                          第 {index + 1} 棒
                        </span>
                        <input
                          type="text"
                          value={step.title}
                          onChange={(e) => {
                            const next = [...drafts];
                            next[index] = { ...step, title: e.target.value };
                            setDrafts(next);
                          }}
                          className="flex-1 px-2.5 py-1.5 text-sm font-medium bg-white border border-slate-200 rounded-md"
                        />
                        <select
                          aria-label={`第 ${index + 1} 棒指派模型`}
                          value={step.toolId}
                          onChange={(e) => {
                            const nextTool = tools.find((t) => t.id === e.target.value);
                            const next = [...drafts];
                            next[index] = {
                              ...step,
                              toolId: e.target.value,
                              preferredChannel:
                                nextTool?.channels && !nextTool.channels.web.available
                                  ? 'app'
                                  : step.preferredChannel,
                            };
                            setDrafts(next);
                          }}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
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
                        <select
                          aria-label={`第 ${index + 1} 棒執行端`}
                          value={step.preferredChannel ?? 'auto'}
                          onChange={(e) => {
                            const val = e.target.value;
                            const next = [...drafts];
                            next[index] = {
                              ...step,
                              preferredChannel:
                                val === 'web' || val === 'app'
                                  ? (val as ChannelType)
                                  : undefined,
                            };
                            setDrafts(next);
                          }}
                          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                        >
                          <option value="auto">自動 Web/App</option>
                          <option value="web" disabled={!selectedSummary?.webAvailable}>
                            網頁版{selectedSummary ? ` (剩 ${selectedSummary.webRemaining})` : ''}
                          </option>
                          <option value="app" disabled={!selectedSummary?.appAvailable}>
                            App 版{selectedSummary ? ` (剩 ${selectedSummary.appRemaining})` : ''}
                          </option>
                        </select>
                        <button
                          type="button"
                          aria-label="移除步驟"
                          onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
                          className="p-1.5 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-xs text-slate-500">
                        {step.capabilityTag} · {step.routingReason}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap shrink-0"
            >
              儲存並自動排程分流
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
