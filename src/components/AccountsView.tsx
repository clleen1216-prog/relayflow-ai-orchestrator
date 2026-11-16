import { useState } from 'react';
import type { User } from 'firebase/auth';
import { Cloud, LogIn, LogOut, Plus, Smartphone, Trash2, UserCheck } from 'lucide-react';
import type { AITool, LinkedAccount } from '../types';
import { getToolEffectiveSummary } from '../utils/toolCredits';

interface AccountsViewProps {
  user: User | null;
  authReady: boolean;
  syncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  syncError: string | null;
  tools: AITool[];
  linkedAccounts: LinkedAccount[];
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onAddLinkedAccount: (account: Omit<LinkedAccount, 'id' | 'ownerId'>) => Promise<void>;
  onToggleLinkedAccount: (account: LinkedAccount) => Promise<void>;
  onDeleteLinkedAccount: (accountId: string) => Promise<void>;
}

export function AccountsView({
  user,
  authReady,
  syncStatus,
  syncError,
  tools,
  linkedAccounts,
  onSignIn,
  onSignOut,
  onAddLinkedAccount,
  onToggleLinkedAccount,
  onDeleteLinkedAccount,
}: AccountsViewProps) {
  const [label, setLabel] = useState('');
  const [emailAlias, setEmailAlias] = useState('');
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>(['gemini', 'chatgpt', 'grok']);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Aggregate Web vs App vs Account-Stacked credits
  let baseWebTotal = 0;
  let baseAppIndependentTotal = 0;
  let accountBonusTotal = 0;

  for (const tool of tools) {
    if (!tool.enabled) continue;
    const baseOnly = getToolEffectiveSummary(tool, []);
    const withAccounts = getToolEffectiveSummary(tool, linkedAccounts);
    baseWebTotal += tool.channels?.web.available ? tool.channels.web.dailyLimit : 0;
    if (tool.channels?.app.available && !tool.channels.app.isSharedQuota) {
      baseAppIndependentTotal += tool.channels.app.dailyLimit;
    }
    accountBonusTotal += Math.max(0, withAccounts.totalLimit - baseOnly.totalLimit);
  }

  const toggleToolSelection = (toolId: string) => {
    setSelectedToolIds((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId]
    );
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !emailAlias.trim() || selectedToolIds.length === 0) return;
    setSubmitting(true);
    try {
      await onAddLinkedAccount({
        label: label.trim(),
        emailAlias: emailAlias.trim(),
        toolIds: selectedToolIds,
        notes: notes.trim(),
        enabled: true,
      });
      setLabel('');
      setEmailAlias('');
      setNotes('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Personal Account Login & Cloud Sync Card */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        <div className="space-y-1.5 max-w-2xl">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Cloud className="w-4 h-4 text-blue-600" />
            <span>個人帳號雲端工作區與額度擴充中心</span>
          </div>
          <h2 className="text-lg font-semibold text-slate-900">
            {user ? `已登入個人帳號：${user.displayName || user.email}` : '登入個人 Google 帳號以擴充 AI 工具與額度'}
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">
            {user
              ? `目前帳號 (${user.email}) 已與雲端資料庫即時同步。您可在下方綁定多組個人或工作用 AI 登入帳號，系統將自動疊加每日可用 Credits 並跨裝置保存所有接力脈絡。`
              : '登入個人帳號後，即可啟用跨裝置 Firestore 雲端同步、永久保存自訂 AI 工具庫，並可掛載多組分身/工作帳號來擴充每日免費額度上限。'}
          </p>
          {syncError && (
            <p className="text-xs text-red-600 pt-1">同步提示：{syncError}</p>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {user && (
            <span className="text-xs font-medium text-slate-600">
              {syncStatus === 'syncing'
                ? '雲端同步中...'
                : syncStatus === 'synced'
                ? '已同步至雲端'
                : syncStatus === 'error'
                ? '同步異常'
                : '連線就緒'}
            </span>
          )}

          {!authReady ? (
            <span className="text-xs text-slate-400">檢查登入狀態中...</span>
          ) : user ? (
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              登出帳號
            </button>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <LogIn className="w-3.5 h-3.5" />
              使用 Google 帳號登入
            </button>
          )}
        </div>
      </section>

      {/* Web vs App vs Account Credit Assessment Strip */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">單帳號網頁版 (Web) 基礎池</p>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
            {baseWebTotal} <span className="text-xs font-normal text-slate-500">Credits / 日</span>
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            來自 Grok、Google AI Studio、Copilot、Leonardo 等瀏覽器免費額度
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500">App 版獨立資源加成</p>
            <Smartphone className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-emerald-700">
            +{baseAppIndependentTotal}{' '}
            <span className="text-xs font-normal text-slate-500">Credits / 日</span>
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            含 Samsung Bixby 裝置端、Gemini App、Grok App 與 Copilot App 獨立配額
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500">個人額外登入帳號疊加</p>
            <UserCheck className="w-4 h-4 text-blue-600" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-blue-700">
            +{accountBonusTotal}{' '}
            <span className="text-xs font-normal text-slate-500">Credits / 日</span>
          </p>
          <p className="mt-1.5 text-xs text-slate-500">
            已啟用 {linkedAccounts.filter((a) => a.enabled).length} 組額外綁定帳號擴充額度
          </p>
        </div>
      </section>

      {/* Linked Account Profiles Manager (Requires Sign-In for Cloud Storage) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              個人綁定帳號與 AI 額度疊加管理
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              若您同時擁有個人 Gmail、公司開發信箱或第二組 X / Microsoft 帳號，可綁定於此以合法管理並疊加各工具的每日免費額度。
            </p>
          </div>
        </div>

        {!user ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm font-medium text-slate-800">
              請先登入您的個人 Google 帳號，以新增並雲端儲存綁定帳號與額度配置
            </p>
            <p className="text-xs text-slate-500">
              未登入訪客模式僅提供單帳號預設基準；登入後可自由新增多組帳號並跨裝置同步。
            </p>
            <button
              type="button"
              onClick={onSignIn}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              立即登入擴充額度
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-6">
            {/* Add Linked Account Form */}
            <form
              onSubmit={handleCreateAccount}
              className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">帳號識別名稱</label>
                  <input
                    type="text"
                    required
                    placeholder="例：工作開發 Google 帳號"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">帳號信箱 / ID 備註</label>
                  <input
                    type="text"
                    required
                    placeholder="例：dev-team@company.com"
                    value={emailAlias}
                    onChange={(e) => setEmailAlias(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700">用途備註（選填）</label>
                  <input
                    type="text"
                    placeholder="例：專用於 AI Studio 與 Leonardo 生圖"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-slate-700">
                  此帳號可登入並疊加免費額度的 AI 工具（至少選 1 項）
                </label>
                <div className="flex flex-wrap gap-2">
                  {tools.map((tool) => {
                    const checked = selectedToolIds.includes(tool.id);
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => toggleToolSelection(tool.id)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                          checked
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {tool.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting || selectedToolIds.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {submitting ? '儲存中...' : '綁定此帳號並疊加額度'}
                </button>
              </div>
            </form>

            {/* Existing Linked Accounts List */}
            {linkedAccounts.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-4">
                目前僅使用主帳號基準額度。可於上方表單新增第二組帳號以立即擴充可用 Credits。
              </p>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                {linkedAccounts.map((acc) => (
                  <div
                    key={acc.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        <span>{acc.label}</span>
                        <span className="text-xs font-normal font-mono text-slate-500">
                          {acc.emailAlias}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        涵蓋工具：
                        {acc.toolIds
                          .map((id) => tools.find((t) => t.id === id)?.name ?? id)
                          .join(' · ')}
                      </p>
                      {acc.notes && <p className="text-xs text-slate-400">{acc.notes}</p>}
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onToggleLinkedAccount(acc)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                          acc.enabled
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                            : 'bg-slate-100 border-slate-200 text-slate-600'
                        }`}
                      >
                        {acc.enabled ? '額度疊加中' : '已暫停'}
                      </button>
                      <button
                        type="button"
                        aria-label={`刪除帳號 ${acc.label}`}
                        onClick={() => onDeleteLinkedAccount(acc.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
