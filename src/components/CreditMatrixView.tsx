import { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Globe,
  Minus,
  Plus,
  RotateCcw,
  Smartphone,
} from 'lucide-react';
import type {
  AITool,
  LinkedAccount,
  PreferredChannelMode,
  ToolCategory,
} from '../types';
import { getToolEffectiveSummary, normalizeToolWithSummary } from '../utils/toolCredits';

interface ToolProbeResult {
  id: string;
  name: string;
  url: string;
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  note: string;
}

interface CreditMatrixViewProps {
  tools: AITool[];
  linkedAccounts: LinkedAccount[];
  onUpdateTool: (toolId: string, patch: Partial<AITool>) => void;
  onResetAllCredits: () => void;
  onAddCustomTool: (tool: AITool) => void;
}

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  research: '即時查證與輿情',
  reasoning: '深度邏輯推理',
  writing: '長文與語氣潤飾',
  coding: '程式與測試工程',
  multimodal: '長上下文與裝置端',
  visual: '視覺與圖像生成',
};

export function CreditMatrixView({
  tools,
  linkedAccounts,
  onUpdateTool,
  onResetAllCredits,
  onAddCustomTool,
}: CreditMatrixViewProps) {
  const [channelFilter, setChannelFilter] = useState<
    'all' | 'independent_app' | 'app_only' | 'shared'
  >('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [category, setCategory] = useState<ToolCategory>('multimodal');
  const [strengthText, setStrengthText] = useState('');
  const [webLimit, setWebLimit] = useState(20);
  const [appLimit, setAppLimit] = useState(10);
  const [isSharedQuota, setIsSharedQuota] = useState(false);
  const [costPerStep, setCostPerStep] = useState(2);
  const [testingTools, setTestingTools] = useState(false);
  const [probeResults, setProbeResults] = useState<Record<string, ToolProbeResult>>({});
  const [probeSummary, setProbeSummary] = useState<{
    passed: number;
    total: number;
    geminiConfigured: boolean;
    testedAt: string;
  } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const handleTestAllTools = async () => {
    setTestingTools(true);
    setProbeError(null);
    try {
      const res = await fetch('/api/tools/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: tools.map((t) => ({
            id: t.id,
            name: t.name,
            officialUrl: t.officialUrl,
          })),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        testedAt?: string;
        geminiConfigured?: boolean;
        results?: ToolProbeResult[];
        error?: string;
      };
      if (!res.ok || !data.results) {
        throw new Error(data.error ?? '工具連線測試失敗');
      }
      const nextMap: Record<string, ToolProbeResult> = {};
      for (const r of data.results) {
        nextMap[r.id] = r;
      }
      setProbeResults(nextMap);
      setProbeSummary({
        passed: data.results.filter((r) => r.reachable).length,
        total: data.results.length,
        geminiConfigured: Boolean(data.geminiConfigured),
        testedAt: data.testedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : '無法完成工具測試');
    } finally {
      setTestingTools(false);
    }
  };

  const filteredTools = tools.filter((tool) => {
    const s = getToolEffectiveSummary(tool, linkedAccounts);
    if (channelFilter === 'independent_app') {
      return s.webAvailable && s.appAvailable && !s.isSharedQuota;
    }
    if (channelFilter === 'app_only') {
      return !s.webAvailable && s.appAvailable;
    }
    if (channelFilter === 'shared') {
      return s.isSharedQuota;
    }
    return true;
  });

  const handleAdjustChannelUsage = (
    tool: AITool,
    channel: 'web' | 'app',
    delta: number
  ) => {
    const summary = getToolEffectiveSummary(tool, linkedAccounts);
    if (!tool.channels) {
      onUpdateTool(tool.id, {
        usedToday: Math.min(summary.totalLimit, Math.max(0, tool.usedToday + delta)),
      });
      return;
    }

    const nextWeb = { ...tool.channels.web };
    const nextApp = { ...tool.channels.app };
    if (channel === 'web') {
      const cap = summary.isSharedQuota ? summary.totalLimit : summary.webLimit;
      nextWeb.usedToday = Math.min(cap, Math.max(0, nextWeb.usedToday + delta));
    } else {
      const cap = summary.isSharedQuota ? summary.totalLimit : summary.appLimit;
      nextApp.usedToday = Math.min(cap, Math.max(0, nextApp.usedToday + delta));
    }

    const updated = normalizeToolWithSummary(
      { ...tool, channels: { web: nextWeb, app: nextApp } },
      linkedAccounts
    );
    onUpdateTool(tool.id, {
      channels: updated.channels,
      dailyLimit: updated.dailyLimit,
      usedToday: updated.usedToday,
    });
  };

  const handleAdjustWebBaseLimit = (tool: AITool, delta: number) => {
    if (!tool.channels) {
      onUpdateTool(tool.id, { dailyLimit: Math.max(1, tool.dailyLimit + delta) });
      return;
    }
    const nextWeb = {
      ...tool.channels.web,
      dailyLimit: Math.max(0, tool.channels.web.dailyLimit + delta),
      available: tool.channels.web.dailyLimit + delta > 0,
    };
    const updated = normalizeToolWithSummary(
      { ...tool, channels: { ...tool.channels, web: nextWeb } },
      linkedAccounts
    );
    onUpdateTool(tool.id, {
      channels: updated.channels,
      dailyLimit: updated.dailyLimit,
      usedToday: updated.usedToday,
    });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = `custom-${Date.now()}`;
    const hasWeb = webLimit > 0;
    const hasApp = appLimit > 0;

    const newTool = normalizeToolWithSummary(
      {
        id,
        name: name.trim(),
        provider: provider.trim() || '自訂整合',
        modelLabel: hasWeb && hasApp ? 'Web + App 雙端' : hasApp ? 'App 專用' : '網頁版',
        category,
        strengths: (() => {
          const parsed = strengthText
            .split(/[、,，]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 3);
          return parsed.length > 0 ? parsed : ['通用任務處理'];
        })(),
        dailyLimit: Math.max(1, webLimit + (isSharedQuota ? 0 : appLimit)),
        usedToday: 0,
        unitLabel: 'Credits',
        resetRule: '每日 00:00 重置',
        resetHoursRemaining: 24,
        costPerStep: Math.max(1, costPerStep),
        enabled: true,
        fallbackToolIds: ['gemini', 'chatgpt'],
        officialUrl: 'https://www.google.com',
        preferredChannel: hasWeb ? 'auto' : 'app',
        accountCount: 1,
        channels: {
          web: {
            available: hasWeb,
            dailyLimit: Math.max(0, webLimit),
            usedToday: 0,
            notes: hasWeb ? '自訂網頁版每日額度' : '無網頁版',
          },
          app: {
            available: hasApp,
            dailyLimit: Math.max(0, appLimit),
            usedToday: 0,
            platformLabel: hasApp ? '行動 / 桌面 App' : '無獨立 App',
            isSharedQuota,
            notes: hasApp
              ? isSharedQuota
                ? '與網頁版共享額度池'
                : '獨立 App 版免費額度池'
              : '僅限網頁端',
          },
        },
      },
      linkedAccounts
    );

    onAddCustomTool(newTool);
    setName('');
    setProvider('');
    setStrengthText('');
    setShowAddForm(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            AI 工具免費額度庫 · Web 版與 App 版雙軌評估
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            同時追蹤網頁版與手機/桌面 App 版免費額度，區分「獨立加成池」與「共享額度池」，並支援綁定個人多帳號疊加容量。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {[
              { id: 'all', label: '全部工具' },
              { id: 'independent_app', label: 'App 獨立加額' },
              { id: 'app_only', label: '純 App / 裝置端' },
              { id: 'shared', label: 'Web/App 共享池' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setChannelFilter(item.id as typeof channelFilter)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  channelFilter === item.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleTestAllTools}
            disabled={testingTools}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <Activity className="w-3.5 h-3.5" />
            {testingTools ? '連線診斷中...' : '測試各 AI 工具連線'}
          </button>
          <button
            type="button"
            onClick={onResetAllCredits}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            全部重置
          </button>
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            新增 AI 工具
          </button>
        </div>
      </div>

      {probeError && (
        <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
          連線診斷失敗：{probeError}
        </div>
      )}

      {probeSummary && (
        <div className="px-4 py-3 bg-white border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-800">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>
              外部端點連線測試完成：
              <strong className="font-mono tabular-nums">
                {probeSummary.passed} / {probeSummary.total}
              </strong>{' '}
              項 AI 服務端點可正常解析與連結
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className={probeSummary.geminiConfigured ? 'text-emerald-700' : 'text-amber-700'}>
              工作台接力 AI 引擎：{probeSummary.geminiConfigured ? '已連線就緒' : '未設定 API Key（本地規則備援中）'}
            </span>
          </div>
          <span className="font-mono tabular-nums text-slate-400">
            {new Date(probeSummary.testedAt).toLocaleTimeString()}
          </span>
        </div>
      )}

      {showAddForm && (
        <form
          onSubmit={handleCreate}
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-6 gap-4 items-end"
        >
          <div className="md:col-span-2 space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">AI 工具 / 模型名稱</label>
            <input
              type="text"
              required
              placeholder="例：NotebookLM / Poe / Cursor Free"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">服務商</label>
            <input
              type="text"
              placeholder="例：Google / Quora"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">核心強項類別</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ToolCategory)}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">網頁版每日額度</label>
            <input
              type="number"
              min={0}
              max={500}
              value={webLimit}
              onChange={(e) => setWebLimit(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">App 版每日額度</label>
            <input
              type="number"
              min={0}
              max={500}
              value={appLimit}
              onChange={(e) => setAppLimit(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="md:col-span-3 space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">模型專長標籤（以頓號分隔）</label>
            <input
              type="text"
              placeholder="例：PDF 講義問答、雙人 Podcast 腳本、程式自動補全"
              value={strengthText}
              onChange={(e) => setStrengthText(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">單步消耗</label>
            <input
              type="number"
              min={1}
              max={50}
              value={costPerStep}
              onChange={(e) => setCostPerStep(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-2 pb-2">
            <input
              id="shared-quota-check"
              type="checkbox"
              checked={isSharedQuota}
              onChange={(e) => setIsSharedQuota(e.target.checked)}
              className="rounded border-slate-300"
            />
            <label htmlFor="shared-quota-check" className="text-xs text-slate-700">
              Web 與 App 共享同池額度
            </label>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg whitespace-nowrap shrink-0"
            >
              加入工具庫
            </button>
          </div>
        </form>
      )}

      {/* High-density Credit Matrix Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[1040px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
              <th className="py-3 px-4">AI 工具與強項</th>
              <th className="py-3 px-4">網頁版 (Web) 額度</th>
              <th className="py-3 px-4">App 版 (行動/裝置端) 額度</th>
              <th className="py-3 px-4">雙端資源評估與策略</th>
              <th className="py-3 px-4 text-right">總剩餘 / 上限</th>
              <th className="py-3 px-4 text-right">通道偏好與狀態</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {filteredTools.map((tool) => {
              const summary = getToolEffectiveSummary(tool, linkedAccounts);
              const isExhausted = summary.totalRemaining < tool.costPerStep;

              return (
                <tr
                  key={tool.id}
                  className={`hover:bg-slate-50/80 transition-colors ${
                    !tool.enabled ? 'opacity-55' : ''
                  }`}
                >
                  <td className="py-4 px-4 align-top max-w-[230px]">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-slate-900">{tool.name}</span>
                      <a
                        href={tool.officialUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`開啟 ${tool.name} 官網`}
                        className="text-slate-400 hover:text-blue-600 shrink-0"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {tool.provider} · {CATEGORY_LABELS[tool.category]}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">{tool.strengths.join(' · ')}</p>
                    {probeResults[tool.id] && (
                      <p
                        className={`text-xs mt-1 font-mono tabular-nums ${
                          probeResults[tool.id].reachable ? 'text-emerald-700' : 'text-red-600'
                        }`}
                      >
                        {probeResults[tool.id].note} · {probeResults[tool.id].latencyMs}ms
                      </p>
                    )}
                    {summary.accountCount > 1 && (
                      <p className="text-xs font-medium text-blue-700 mt-1 font-mono tabular-nums">
                        已綁定 {summary.accountCount} 組帳號（額度 ×{summary.accountCount}）
                      </p>
                    )}
                  </td>

                  {/* Web Channel Cell */}
                  <td className="py-4 px-4 align-top">
                    {summary.webAvailable ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-xs text-slate-700">
                          <Globe className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-mono tabular-nums font-semibold">
                            剩 {summary.webRemaining} / {summary.webLimit}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label={`減少 ${tool.name} 網頁版已用`}
                            onClick={() => handleAdjustChannelUsage(tool, 'web', -1)}
                            className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-600"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="text-xs font-mono tabular-nums text-slate-500 px-1">
                            已用 {summary.webUsed}
                          </span>
                          <button
                            type="button"
                            aria-label={`增加 ${tool.name} 網頁版已用`}
                            onClick={() => handleAdjustChannelUsage(tool, 'web', 1)}
                            className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-600"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAdjustWebBaseLimit(tool, 5)}
                            className="ml-1 text-xs text-blue-600 hover:underline"
                          >
                            +5上限
                          </button>
                        </div>
                        <p className="text-xs text-slate-400 max-w-[200px] leading-snug">
                          {tool.channels?.web.notes}
                        </p>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 space-y-1">
                        <div>無網頁版</div>
                        <p className="max-w-[180px] leading-snug">{tool.channels?.web.notes}</p>
                      </div>
                    )}
                  </td>

                  {/* App Channel Cell */}
                  <td className="py-4 px-4 align-top">
                    {summary.appAvailable ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5 text-xs text-slate-700">
                          <Smartphone className="w-3.5 h-3.5 text-emerald-600" />
                          <span className="font-mono tabular-nums font-semibold">
                            {summary.isSharedQuota
                              ? `共享剩 ${summary.appRemaining}`
                              : `剩 ${summary.appRemaining} / ${summary.appLimit}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label={`減少 ${tool.name} App 版已用`}
                            onClick={() => handleAdjustChannelUsage(tool, 'app', -1)}
                            className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-600"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="text-xs font-mono tabular-nums text-slate-500 px-1">
                            已用 {summary.appUsed}
                          </span>
                          <button
                            type="button"
                            aria-label={`增加 ${tool.name} App 版已用`}
                            onClick={() => handleAdjustChannelUsage(tool, 'app', 1)}
                            className="p-1 rounded border border-slate-200 hover:bg-slate-100 text-slate-600"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                        <p className="text-xs text-slate-400 max-w-[210px] leading-snug">
                          {tool.channels?.app.platformLabel} · {tool.channels?.app.notes}
                        </p>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 space-y-1">
                        <div>無獨立 App</div>
                        <p className="max-w-[180px] leading-snug">{tool.channels?.app.notes}</p>
                      </div>
                    )}
                  </td>

                  {/* Evaluation Verdict */}
                  <td className="py-4 px-4 align-top max-w-[240px]">
                    <p className="text-xs font-medium text-slate-800 leading-relaxed">
                      {summary.evaluationVerdict}
                    </p>
                    <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
                      {tool.resetRule} · 單步 -{tool.costPerStep}
                    </p>
                  </td>

                  {/* Total Combined Pool */}
                  <td className="py-4 px-4 align-top text-right">
                    <div className="text-base font-mono tabular-nums font-bold text-slate-900">
                      <span
                        className={
                          isExhausted
                            ? 'text-red-600'
                            : summary.totalRemaining <= summary.totalLimit * 0.3
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                        }
                      >
                        {summary.totalRemaining}
                      </span>{' '}
                      <span className="text-xs font-normal text-slate-400">
                        / {summary.totalLimit}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">{tool.unitLabel}</div>
                  </td>

                  {/* Channel Preference & Toggle */}
                  <td className="py-4 px-4 align-top text-right space-y-2">
                    <div>
                      <select
                        aria-label={`${tool.name} 通道偏好`}
                        value={tool.preferredChannel ?? 'auto'}
                        onChange={(e) =>
                          onUpdateTool(tool.id, {
                            preferredChannel: e.target.value as PreferredChannelMode,
                          })
                        }
                        className="bg-slate-50 border border-slate-200 rounded-md px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="auto">自動優先 Web 後切 App</option>
                        <option value="web" disabled={!summary.webAvailable}>
                          鎖定網頁版
                        </option>
                        <option value="app" disabled={!summary.appAvailable}>
                          優先 App 版
                        </option>
                      </select>
                    </div>

                    <div className="inline-flex items-center gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateTool(tool.id, {
                            usedToday: 0,
                            channels: tool.channels
                              ? {
                                  web: { ...tool.channels.web, usedToday: 0 },
                                  app: { ...tool.channels.app, usedToday: 0 },
                                }
                              : undefined,
                          })
                        }
                        className="text-xs text-slate-600 hover:text-slate-900 underline whitespace-nowrap shrink-0"
                      >
                        重置今日
                      </button>
                      <button
                        type="button"
                        onClick={() => onUpdateTool(tool.id, { enabled: !tool.enabled })}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                          tool.enabled
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                            : 'bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200'
                        }`}
                      >
                        {tool.enabled ? '啟用中' : '已停用'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
