import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FolderArchive,
  GitBranch,
  LogOut,
  Rocket,
} from 'lucide-react';
import type { WorkspaceState } from '../types';

interface ExportManifest {
  fileCount: number;
  totalBytes: number;
  files: string[];
  githubOAuthConfigured: boolean;
  vercelOAuthConfigured: boolean;
  githubCallbackUrl: string;
  vercelCallbackUrl: string;
}

interface GitHubRepo {
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

interface GitHubStatus {
  connected: boolean;
  username?: string;
  avatarUrl?: string;
  profileUrl?: string;
  repos: GitHubRepo[];
}

interface VercelStatus {
  connected: boolean;
  username?: string;
  email?: string;
}

interface ExportDeployViewProps {
  workspaceState: WorkspaceState;
}

export function ExportDeployView({ workspaceState }: ExportDeployViewProps) {
  const [manifest, setManifest] = useState<ExportManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [showFileList, setShowFileList] = useState(false);

  const [zipDownloading, setZipDownloading] = useState(false);
  const [zipMessage, setZipMessage] = useState<string | null>(null);

  const [ghStatus, setGhStatus] = useState<GitHubStatus>({ connected: false, repos: [] });
  const [ghMode, setGhMode] = useState<'new' | 'existing'>('new');
  const [ghRepoName, setGhRepoName] = useState('relayflow-ai-orchestrator');
  const [ghExistingRepo, setGhExistingRepo] = useState('');
  const [ghPrivate, setGhPrivate] = useState(true);
  const [ghCommitMsg, setGhCommitMsg] = useState('Deploy RelayFlow multi-AI orchestrator');
  const [ghPushing, setGhPushing] = useState(false);
  const [ghResult, setGhResult] = useState<{
    repoUrl: string;
    commitSha: string;
    fileCount: number;
    vercelImportUrl: string;
  } | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);

  const [vercelStatus, setVercelStatus] = useState<VercelStatus>({ connected: false });
  const [vercelProjectName, setVercelProjectName] = useState('relayflow-ai');
  const [vercelTarget, setVercelTarget] = useState<'production' | 'preview'>('production');
  const [vercelDeploying, setVercelDeploying] = useState(false);
  const [vercelResult, setVercelResult] = useState<{
    url: string;
    inspectorUrl?: string;
    readyState: string;
  } | null>(null);
  const [vercelError, setVercelError] = useState<string | null>(null);

  const [ghShowHelp, setGhShowHelp] = useState(false);
  const [ghPatInput, setGhPatInput] = useState('');
  const [ghPatSubmitting, setGhPatSubmitting] = useState(false);

  const [vercelShowHelp, setVercelShowHelp] = useState(false);
  const [vercelPatInput, setVercelPatInput] = useState('');
  const [vercelPatSubmitting, setVercelPatSubmitting] = useState(false);

  const [copiedField, setCopiedField] = useState<string | null>(null);

  const refreshStatuses = useCallback(async () => {
    try {
      const originParam = encodeURIComponent(window.location.origin);
      const [mRes, ghRes, vRes] = await Promise.all([
        fetch(`/api/export/manifest?origin=${originParam}`),
        fetch('/api/github/status'),
        fetch('/api/vercel/status'),
      ]);
      if (mRes.ok) {
        setManifest((await mRes.json()) as ExportManifest);
      }
      if (ghRes.ok) {
        const gh = (await ghRes.json()) as GitHubStatus;
        setGhStatus(gh);
        if (gh.repos.length > 0) {
          setGhExistingRepo((prev) => prev || gh.repos[0].fullName);
        }
      }
      if (vRes.ok) {
        setVercelStatus((await vRes.json()) as VercelStatus);
      }
    } finally {
      setManifestLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (
        origin !== window.location.origin &&
        !origin.endsWith('.run.app') &&
        !origin.endsWith('.vercel.app') &&
        !origin.includes('localhost')
      ) {
        return;
      }
      if (
        event.data?.type === 'GITHUB_OAUTH_SUCCESS' ||
        event.data?.type === 'VERCEL_OAUTH_SUCCESS'
      ) {
        void refreshStatuses();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [refreshStatuses]);

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(key);
      setTimeout(() => setCopiedField((prev) => (prev === key ? null : prev)), 1800);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleDownloadZip = async () => {
    setZipDownloading(true);
    setZipMessage(null);
    try {
      const res = await fetch('/api/export/zip');
      if (!res.ok) throw new Error('打包下載失敗');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'relayflow-app.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setZipMessage('已下載完整專案壓縮檔 relayflow-app.zip 至本機。');
    } catch (error) {
      setZipMessage(error instanceof Error ? error.message : '下載 ZIP 時發生錯誤');
    } finally {
      setZipDownloading(false);
    }
  };

  const handleDownloadWorkspaceJson = () => {
    const blob = new Blob([JSON.stringify(workspaceState, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relayflow-backup-${workspaceState.currentDate}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleConnectGitHub = async () => {
    setGhError(null);
    try {
      const originParam = encodeURIComponent(window.location.origin);
      const res = await fetch(`/api/auth/github/url?origin=${originParam}`);
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? '無法取得 GitHub OAuth 連結');
      }
      const popup = window.open(data.url, 'github_oauth_popup', 'width=640,height=720');
      if (!popup) {
        setGhError('瀏覽器封鎖了彈出視窗，請允許此網站開啟彈窗後再試一次。');
      }
    } catch (error) {
      setGhError(error instanceof Error ? error.message : '連結 GitHub 失敗');
    }
  };

  const handleConnectGitHubPat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ghPatInput.trim()) return;
    setGhPatSubmitting(true);
    setGhError(null);
    try {
      const res = await fetch('/api/github/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ghPatInput.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? 'GitHub Token 驗證失敗');
      }
      setGhPatInput('');
      setGhShowHelp(false);
      await refreshStatuses();
    } catch (error) {
      setGhError(error instanceof Error ? error.message : 'GitHub Token 連線失敗');
    } finally {
      setGhPatSubmitting(false);
    }
  };

  const handlePushToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    setGhPushing(true);
    setGhError(null);
    setGhResult(null);
    try {
      const targetRepo = ghMode === 'existing' ? ghExistingRepo : ghRepoName;
      const res = await fetch('/api/deploy/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoName: targetRepo,
          isPrivate: ghPrivate,
          commitMessage: ghCommitMsg,
          useExisting: ghMode === 'existing',
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        repoUrl?: string;
        commitSha?: string;
        fileCount?: number;
        vercelImportUrl?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.repoUrl) {
        throw new Error(data.error ?? '推送至 GitHub 失敗');
      }
      setGhResult({
        repoUrl: data.repoUrl,
        commitSha: data.commitSha ?? '',
        fileCount: data.fileCount ?? 0,
        vercelImportUrl: data.vercelImportUrl ?? 'https://vercel.com/new',
      });
      void refreshStatuses();
    } catch (error) {
      setGhError(error instanceof Error ? error.message : '推送失敗');
    } finally {
      setGhPushing(false);
    }
  };

  const handleConnectVercel = async () => {
    setVercelError(null);
    try {
      const originParam = encodeURIComponent(window.location.origin);
      const res = await fetch(`/api/auth/vercel/url?origin=${originParam}`);
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? '無法取得 Vercel OAuth 連結');
      }
      const popup = window.open(data.url, 'vercel_oauth_popup', 'width=640,height=720');
      if (!popup) {
        setVercelError('瀏覽器封鎖了彈出視窗，請允許此網站開啟彈窗後再試一次。');
      }
    } catch (error) {
      setVercelError(error instanceof Error ? error.message : '連結 Vercel 失敗');
    }
  };

  const handleConnectVercelPat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vercelPatInput.trim()) return;
    setVercelPatSubmitting(true);
    setVercelError(null);
    try {
      const res = await fetch('/api/vercel/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: vercelPatInput.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? 'Vercel Token 驗證失敗');
      }
      setVercelPatInput('');
      setVercelShowHelp(false);
      await refreshStatuses();
    } catch (error) {
      setVercelError(error instanceof Error ? error.message : 'Vercel Token 連線失敗');
    } finally {
      setVercelPatSubmitting(false);
    }
  };

  const handleDeployToVercel = async (e: React.FormEvent) => {
    e.preventDefault();
    setVercelDeploying(true);
    setVercelError(null);
    setVercelResult(null);
    try {
      const res = await fetch('/api/deploy/vercel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: vercelProjectName,
          target: vercelTarget,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        url?: string;
        inspectorUrl?: string;
        readyState?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.url) {
        throw new Error(data.error ?? 'Vercel 部署失敗');
      }
      setVercelResult({
        url: data.url,
        inspectorUrl: data.inspectorUrl,
        readyState: data.readyState ?? 'BUILDING',
      });
    } catch (error) {
      setVercelError(error instanceof Error ? error.message : 'Vercel 部署失敗');
    } finally {
      setVercelDeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Package Overview Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-slate-900">
              應用程式匯出、GitHub 推送與 Vercel.com 部署串聯
            </h2>
            <p className="text-xs text-slate-500">
              將完成後的 RelayFlow 專案打包下載至本機、推送至個人 GitHub Repository，或直接部署上線至 Vercel.com（已自動排除敏感機密檔與 node_modules，並內附 vercel.json 與 api/index.ts Serverless 路由）。
            </p>
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-600 shrink-0">
            <span className="font-mono tabular-nums">
              {manifestLoading
                ? '掃描檔案中...'
                : `${manifest?.fileCount ?? 0} 個原始碼檔案 · ${Math.round(
                    (manifest?.totalBytes ?? 0) / 1024
                  )} KB`}
            </span>
            <button
              type="button"
              onClick={() => setShowFileList((v) => !v)}
              className="text-blue-600 hover:underline font-medium whitespace-nowrap"
            >
              {showFileList ? '隱藏檔案清單' : '檢視打包清單'}
            </button>
          </div>
        </div>

        {showFileList && manifest && (
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg max-h-44 overflow-y-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 text-xs font-mono text-slate-600">
              {manifest.files.map((filePath) => (
                <div key={filePath} className="truncate">
                  {filePath}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Three Deployment Pathways Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        {/* Option 1: Local ZIP Download */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
              <FolderArchive className="w-4 h-4 text-slate-700" />
              <span>選項 01 · 本機離線保存</span>
            </div>
            <h3 className="text-base font-semibold text-slate-900">下載 App ZIP 至本機</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              即時將完整前端介面、Express 後端、Firebase 規則與 Vercel 設定檔壓縮為標準 ZIP，解壓後即可於本機執行 npm install && npm run dev。
            </p>
          </div>

          <div className="space-y-2.5 pt-1">
            <button
              type="button"
              onClick={handleDownloadZip}
              disabled={zipDownloading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors disabled:opacity-60"
            >
              <Download className="w-4 h-4" />
              {zipDownloading ? '正在打包專案 ZIP...' : '下載完整專案 (relayflow-app.zip)'}
            </button>

            <button
              type="button"
              onClick={handleDownloadWorkspaceJson}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
            >
              匯出目前任務與額度資料 (.json 備份)
            </button>
          </div>

          {zipMessage && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {zipMessage}
            </p>
          )}
        </section>

        {/* Option 2: Push to GitHub Repository */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
              <span className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-slate-700" />
                <span>選項 02 · 版本庫託管</span>
              </span>
              {ghStatus.connected && (
                <span className="text-emerald-700 font-semibold">@{ghStatus.username}</span>
              )}
            </div>
            <h3 className="text-base font-semibold text-slate-900">
              上傳 Push 至 GitHub 個人 Repository
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              透過 GitHub OAuth 授權後，直接於您的帳號下建立新 Repository 或推送更新至現有 Repo，並自動產生 Vercel 一鍵匯入連結。
            </p>
          </div>

          {!manifest?.githubOAuthConfigured ? (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs text-slate-600">
              <p className="font-semibold text-slate-800">尚未設定 GitHub OAuth App</p>
              <p className="leading-relaxed">
                請於 GitHub Developer Settings 建立 OAuth App 並於環境 Secrets 加入 GITHUB_CLIENT_ID 與 GITHUB_CLIENT_SECRET，Callback URL 請填寫：
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded font-mono text-[11px] truncate">
                  {manifest?.githubCallbackUrl ?? ''}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy('gh-cb', manifest?.githubCallbackUrl ?? '')}
                  className="p-1.5 bg-white border border-slate-200 rounded hover:bg-slate-100 shrink-0"
                  aria-label="複製 GitHub Callback URL"
                >
                  {copiedField === 'gh-cb' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          ) : !ghStatus.connected ? (
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleConnectGitHub}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <GitBranch className="w-4 h-4" />
                授權連結 GitHub 帳號
              </button>

              <button
                type="button"
                onClick={() => setGhShowHelp((v) => !v)}
                className="w-full text-center text-xs text-slate-500 hover:text-slate-900 underline"
              >
                {ghShowHelp
                  ? '收合 Callback URL 與 Token 連線選項'
                  : '遇到 redirect URL 無效？檢視 Callback URL 或改用 Token'}
              </button>

              {ghShowHelp && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5 text-xs text-slate-600">
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-800">GitHub OAuth Callback URL：</p>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded font-mono text-[11px] truncate">
                        {manifest?.githubCallbackUrl ?? ''}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopy('gh-cb-2', manifest?.githubCallbackUrl ?? '')}
                        className="p-1.5 bg-white border border-slate-200 rounded hover:bg-slate-100 shrink-0"
                        aria-label="複製 GitHub Callback URL"
                      >
                        {copiedField === 'gh-cb-2' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <form onSubmit={handleConnectGitHubPat} className="space-y-1.5 pt-1 border-t border-slate-200">
                    <label className="block font-semibold text-slate-800">
                      或使用 GitHub Personal Access Token（免設 Callback）：
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="password"
                        value={ghPatInput}
                        onChange={(e) => setGhPatInput(e.target.value)}
                        placeholder="ghp_... (需具備 repo 權限)"
                        className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md"
                      />
                      <button
                        type="submit"
                        disabled={ghPatSubmitting}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap disabled:opacity-50"
                      >
                        {ghPatSubmitting ? '驗證中...' : '連線'}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handlePushToGitHub} className="space-y-3.5">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setGhMode('new')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    ghMode === 'new' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  建立新 Repo
                </button>
                <button
                  type="button"
                  onClick={() => setGhMode('existing')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    ghMode === 'existing' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  推送現有 Repo
                </button>
              </div>

              {ghMode === 'new' ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    required
                    value={ghRepoName}
                    onChange={(e) => setGhRepoName(e.target.value)}
                    placeholder="Repository 名稱"
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg"
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={ghPrivate}
                      onChange={(e) => setGhPrivate(e.target.checked)}
                    />
                    設為私人 Repository (Private)
                  </label>
                </div>
              ) : (
                <select
                  value={ghExistingRepo}
                  onChange={(e) => setGhExistingRepo(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg"
                >
                  {ghStatus.repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName} ({r.isPrivate ? 'Private' : 'Public'})
                    </option>
                  ))}
                </select>
              )}

              <input
                type="text"
                value={ghCommitMsg}
                onChange={(e) => setGhCommitMsg(e.target.value)}
                placeholder="Commit 訊息"
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg"
              />

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={ghPushing}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-60"
                >
                  {ghPushing ? '正在上傳檔案並提交...' : '立即 Push 至 GitHub'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch('/api/github/disconnect', { method: 'POST' });
                    void refreshStatuses();
                  }}
                  aria-label="中斷 GitHub 連結"
                  className="p-2.5 border border-slate-200 rounded-lg text-slate-500 hover:text-slate-900"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          )}

          {ghError && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {ghError}
            </p>
          )}

          {ghResult && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2 text-xs text-emerald-900">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                <span>已推送 {ghResult.fileCount} 個檔案</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <a
                  href={ghResult.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                >
                  開啟 GitHub Repo
                  <ExternalLink className="w-3 h-3" />
                </a>
                <a
                  href={ghResult.vercelImportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-slate-900 hover:underline font-medium"
                >
                  一鍵匯入 Vercel 部署
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </section>

        {/* Option 3: Vercel.com Deploy */}
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
              <span className="flex items-center gap-2">
                <Rocket className="w-4 h-4 text-slate-700" />
                <span>選項 03 · 雲端託管上線</span>
              </span>
              {vercelStatus.connected && (
                <span className="text-emerald-700 font-semibold">{vercelStatus.username}</span>
              )}
            </div>
            <h3 className="text-base font-semibold text-slate-900">Vercel.com 直接部署</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              連結 Vercel 帳號即可直接將目前程式碼上傳建立 Production 部署並取得公開網址；亦可透過上方 GitHub 連動匯入。
            </p>
          </div>

          {!manifest?.vercelOAuthConfigured ? (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5 text-xs text-slate-600">
              <p className="font-semibold text-slate-800">Vercel 直接部署設定說明</p>
              <p className="leading-relaxed">
                若要於此工作台內直接觸發 Vercel API 部署，請於環境 Secrets 加入 VERCEL_CLIENT_ID 與 VERCEL_CLIENT_SECRET，並設定 Callback URL：
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded font-mono text-[11px] truncate">
                  {manifest?.vercelCallbackUrl ?? ''}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy('vc-cb', manifest?.vercelCallbackUrl ?? '')}
                  className="p-1.5 bg-white border border-slate-200 rounded hover:bg-slate-100 shrink-0"
                  aria-label="複製 Vercel Callback URL"
                >
                  {copiedField === 'vc-cb' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <a
                href="https://vercel.com/new"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-blue-600 hover:underline font-medium pt-1"
              >
                或前往 Vercel New Project 手動匯入 GitHub / 本機專案
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          ) : !vercelStatus.connected ? (
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleConnectVercel}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors"
              >
                <Rocket className="w-4 h-4" />
                授權連結 Vercel 帳號
              </button>

              <button
                type="button"
                onClick={() => setVercelShowHelp((v) => !v)}
                className="w-full text-center text-xs text-slate-500 hover:text-slate-900 underline"
              >
                {vercelShowHelp
                  ? '收合 Callback URL 與 Token 連線選項'
                  : '出現 redirect URL is invalid？複製 Callback URL 或改用 Token'}
              </button>

              {vercelShowHelp && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5 text-xs text-slate-600">
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-800">
                      請將此網址加入 Vercel App 的 Authorization Callback URLs：
                    </p>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 px-2 py-1 bg-white border border-slate-200 rounded font-mono text-[11px] truncate">
                        {manifest?.vercelCallbackUrl ?? ''}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopy('vc-cb-2', manifest?.vercelCallbackUrl ?? '')}
                        className="p-1.5 bg-white border border-slate-200 rounded hover:bg-slate-100 shrink-0"
                        aria-label="複製 Vercel Callback URL"
                      >
                        {copiedField === 'vc-cb-2' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <form onSubmit={handleConnectVercelPat} className="space-y-1.5 pt-1 border-t border-slate-200">
                    <label className="block font-semibold text-slate-800">
                      或貼上 Vercel Access Token 直接部署（vercel.com/account/tokens）：
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="password"
                        value={vercelPatInput}
                        onChange={(e) => setVercelPatInput(e.target.value)}
                        placeholder="貼上 Vercel Token..."
                        className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md"
                      />
                      <button
                        type="submit"
                        disabled={vercelPatSubmitting}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md whitespace-nowrap disabled:opacity-50"
                      >
                        {vercelPatSubmitting ? '驗證中...' : '連線'}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleDeployToVercel} className="space-y-3.5">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-slate-700">
                  Vercel 專案名稱
                </label>
                <input
                  type="text"
                  required
                  value={vercelProjectName}
                  onChange={(e) => setVercelProjectName(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setVercelTarget('production')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    vercelTarget === 'production'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Production 正式版
                </button>
                <button
                  type="button"
                  onClick={() => setVercelTarget('preview')}
                  className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    vercelTarget === 'preview'
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600'
                  }`}
                >
                  Preview 預覽版
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={vercelDeploying}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-60"
                >
                  {vercelDeploying ? '正在上傳建置...' : '立即部署至 Vercel.com'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch('/api/vercel/disconnect', { method: 'POST' });
                    void refreshStatuses();
                  }}
                  aria-label="中斷 Vercel 連結"
                  className="p-2.5 border border-slate-200 rounded-lg text-slate-500 hover:text-slate-900"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          )}

          {vercelError && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {vercelError}
            </p>
          )}

          {vercelResult && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2 text-xs text-emerald-900">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                <span>已送出 Vercel 部署 ({vercelResult.readyState})</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <a
                  href={vercelResult.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                >
                  開啟部署網址
                  <ExternalLink className="w-3 h-3" />
                </a>
                {vercelResult.inspectorUrl && (
                  <a
                    href={vercelResult.inspectorUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-slate-800 hover:underline font-medium"
                  >
                    檢視建置日誌
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
