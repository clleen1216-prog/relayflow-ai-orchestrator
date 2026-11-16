import type { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  '.data',
  '.git',
  '.aistudio',
  '.vercel',
]);

const EXCLUDED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development.local',
  '.env.production.local',
  'bun.lock',
  'server.js',
  'DRAFT_firestore.rules',
  'security_spec.md',
]);

export interface CollectedFile {
  relativePath: string;
  buffer: Buffer;
}

interface PendingOAuthFlow {
  redirectUri: string;
  codeVerifier?: string;
  createdAt: number;
}

const pendingOAuthFlows = new Map<string, PendingOAuthFlow>();

function prunePendingOAuthFlows() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, value] of pendingOAuthFlows.entries()) {
    if (value.createdAt < cutoff) {
      pendingOAuthFlows.delete(key);
    }
  }
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAppBaseUrl(): string {
  const raw = process.env.APP_URL;
  if (raw && raw !== 'MY_APP_URL' && raw.startsWith('http')) {
    return raw.replace(/\/$/, '');
  }
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProd) {
    return `https://${vercelProd.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  }
  return 'http://localhost:3000';
}

function resolveAllowedOrigin(rawOrigin: unknown): string {
  const fallback = getAppBaseUrl();
  if (typeof rawOrigin === 'string' && rawOrigin.trim()) {
    try {
      const parsed = new URL(rawOrigin.trim());
      const host = parsed.hostname.toLowerCase();
      if (
        parsed.origin === fallback ||
        (parsed.protocol === 'https:' &&
          (host.endsWith('.run.app') || host.endsWith('.vercel.app'))) ||
        ((parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          (host === 'localhost' || host === '127.0.0.1'))
      ) {
        return parsed.origin;
      }
    } catch {
      // Ignore malformed origin
    }
  }
  return fallback;
}

function generateDeployReadme(): string {
  return `# RelayFlow — 多 AI 接力與免費額度排程工作台

本專案已打包為可直接於本機執行或部署至 Vercel / Node.js 的完整全端架構。

## 本機開發啟動
\`\`\`bash
npm install
cp .env.example .env
# 於 .env 填入 GEMINI_API_KEY
npm run dev
\`\`\`

## 建置與部署至 Vercel
1. 匯入此 GitHub Repository 至 [Vercel](https://vercel.com/new)
2. Framework Preset 選擇 **Vite**，Output Directory 為 \`dist\`（已內附 \`vercel.json\`）
3. 於 Environment Variables 加入 \`GEMINI_API_KEY\`（選填 GitHub/Vercel OAuth 變數）
4. 點擊 Deploy 即可上線。
`;
}

export async function collectProjectFiles(rootDir: string): Promise<CollectedFile[]> {
  const results: CollectedFile[] = [];

  async function walk(currentDir: string, prefix: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILES.has(entry.name) || entry.name.endsWith('.log')) continue;
        const buffer = await fs.readFile(fullPath);
        results.push({ relativePath: relPath, buffer });
      }
    }
  }

  await walk(rootDir, '');
  if (!results.some((f) => f.relativePath === 'README.md')) {
    results.push({
      relativePath: 'README.md',
      buffer: Buffer.from(generateDeployReadme(), 'utf-8'),
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function getCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none' as const,
    maxAge: 1000 * 60 * 60 * 24,
    path: '/',
  };
}

export function registerExportAndDeployRoutes(app: Express, rootDir: string) {
  // 1. Export Manifest & OAuth Callback Diagnostics
  app.get('/api/export/manifest', async (req: Request, res: Response) => {
    try {
      const files = await collectProjectFiles(rootDir);
      const totalBytes = files.reduce((sum, f) => sum + f.buffer.byteLength, 0);
      const baseUrl = resolveAllowedOrigin(req.query.origin);

      res.json({
        fileCount: files.length,
        totalBytes,
        files: files.map((f) => f.relativePath),
        githubOAuthConfigured: Boolean(
          process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ),
        vercelOAuthConfigured: Boolean(
          process.env.VERCEL_CLIENT_ID && process.env.VERCEL_CLIENT_SECRET
        ),
        githubCallbackUrl: `${baseUrl}/auth/github/callback`,
        vercelCallbackUrl: `${baseUrl}/auth/vercel/callback`,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : '無法讀取專案檔案清單',
      });
    }
  });

  // 2. Download Full App ZIP
  app.get('/api/export/zip', async (_req: Request, res: Response) => {
    try {
      const files = await collectProjectFiles(rootDir);
      const zip = new JSZip();

      for (const file of files) {
        zip.file(file.relativePath, file.buffer);
      }

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="relayflow-app.zip"');
      res.setHeader('Content-Length', String(zipBuffer.byteLength));
      res.send(zipBuffer);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : '打包 ZIP 失敗',
      });
    }
  });

  // 3. GitHub OAuth Routes
  app.get('/api/auth/github/url', (req: Request, res: Response) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(503).json({
        error: '尚未於環境設定 GITHUB_CLIENT_ID 與 GITHUB_CLIENT_SECRET，請先完成 GitHub OAuth App 綁定或改用 Personal Access Token。',
      });
      return;
    }

    prunePendingOAuthFlows();
    const baseUrl = resolveAllowedOrigin(req.query.origin);
    const redirectUri = `${baseUrl}/auth/github/callback`;
    const state = toBase64Url(crypto.randomBytes(18));
    pendingOAuthFlows.set(state, { redirectUri, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'repo read:user',
      state,
    });

    res.json({
      url: `https://github.com/login/oauth/authorize?${params.toString()}`,
      redirectUri,
    });
  });

  const handleGitHubCallback = async (req: Request, res: Response) => {
    const oauthError =
      typeof req.query.error_description === 'string'
        ? req.query.error_description
        : typeof req.query.error === 'string'
        ? req.query.error
        : '';
    if (oauthError) {
      res.status(400).send(`<p>GitHub 授權失敗：${oauthError}</p>`);
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = state ? pendingOAuthFlows.get(state) : undefined;
    if (state) pendingOAuthFlows.delete(state);

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (!code || !clientId || !clientSecret) {
      res.status(400).send('<p>GitHub OAuth 授權參數不完整。</p>');
      return;
    }

    const redirectUri = flow?.redirectUri ?? `${getAppBaseUrl()}/auth/github/callback`;

    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error_description?: string;
      };
      if (!tokenData.access_token) {
        throw new Error(tokenData.error_description ?? 'GitHub Token 交換失敗');
      }

      res.cookie('rf_github_token', tokenData.access_token, getCookieOptions());
      res.send(`<!doctype html><html><body><script>
        if (window.opener) {
          window.opener.postMessage({ type: 'GITHUB_OAUTH_SUCCESS' }, '*');
          window.close();
        } else {
          window.location.href = '/';
        }
      </script><p>GitHub 連結成功，視窗將自動關閉。</p></body></html>`);
    } catch (error) {
      res
        .status(500)
        .send(
          `<p>GitHub 授權失敗：${error instanceof Error ? error.message : '未知錯誤'}</p>`
        );
    }
  };

  app.get(['/auth/github/callback', '/auth/github/callback/'], handleGitHubCallback);

  app.post('/api/github/token', async (req: Request, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: '請輸入有效的 GitHub Personal Access Token。' });
      return;
    }
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'RelayFlow-Exporter',
        },
      });
      if (!userRes.ok) {
        res.status(401).json({ error: 'GitHub Token 驗證失敗或權限不足（需具備 repo 權限）。' });
        return;
      }
      const data = (await userRes.json()) as { login?: string };
      res.cookie('rf_github_token', token, getCookieOptions());
      res.json({ ok: true, username: data.login ?? 'github-user' });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : '驗證 GitHub Token 失敗',
      });
    }
  });

  app.get('/api/github/status', async (req: Request, res: Response) => {
    const token = req.cookies?.rf_github_token as string | undefined;
    if (!token) {
      res.json({ connected: false, repos: [] });
      return;
    }

    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'RelayFlow-Exporter',
        },
      });
      if (!userRes.ok) {
        res.clearCookie('rf_github_token', getCookieOptions());
        res.json({ connected: false, repos: [] });
        return;
      }
      const userData = (await userRes.json()) as {
        login: string;
        avatar_url: string;
        html_url: string;
      };

      const reposRes = await fetch(
        'https://api.github.com/user/repos?sort=updated&per_page=25&affiliation=owner',
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'RelayFlow-Exporter',
          },
        }
      );
      const reposRaw = reposRes.ok
        ? ((await reposRes.json()) as Array<{
            name: string;
            full_name: string;
            private: boolean;
            default_branch: string;
            html_url: string;
          }>)
        : [];

      res.json({
        connected: true,
        username: userData.login,
        avatarUrl: userData.avatar_url,
        profileUrl: userData.html_url,
        repos: reposRaw.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          isPrivate: r.private,
          defaultBranch: r.default_branch || 'main',
          htmlUrl: r.html_url,
        })),
      });
    } catch {
      res.json({ connected: false, repos: [] });
    }
  });

  app.post('/api/github/disconnect', (_req: Request, res: Response) => {
    res.clearCookie('rf_github_token', getCookieOptions());
    res.json({ ok: true });
  });

  // 4. Push Project Files to GitHub Repository
  app.post('/api/deploy/github', async (req: Request, res: Response) => {
    const token = req.cookies?.rf_github_token as string | undefined;
    if (!token) {
      res.status(401).json({ error: '尚未連結 GitHub 帳號，請先點擊「連結 GitHub」。' });
      return;
    }

    const { repoName, isPrivate, commitMessage, useExisting } = req.body as {
      repoName?: string;
      isPrivate?: boolean;
      commitMessage?: string;
      useExisting?: boolean;
    };

    const rawRepoInput = (repoName ?? '').trim();
    const cleanRepoName = rawRepoInput.includes('/')
      ? rawRepoInput
          .split('/')
          .pop()!
          .replace(/[^a-zA-Z0-9._-]/g, '-')
      : rawRepoInput.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (!cleanRepoName) {
      res.status(400).json({ error: '請輸入有效的 Repository 名稱。' });
      return;
    }

    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'RelayFlow-Exporter',
    };

    try {
      const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
      if (!userRes.ok) throw new Error('無法取得 GitHub 使用者資訊');
      const ghUser = (await userRes.json()) as { login: string };
      const owner =
        useExisting && rawRepoInput.includes('/')
          ? rawRepoInput.split('/')[0].replace(/[^a-zA-Z0-9._-]/g, '') || ghUser.login
          : ghUser.login;

      let defaultBranch = 'main';
      let repoHtmlUrl = `https://github.com/${owner}/${cleanRepoName}`;

      if (!useExisting) {
        const createRes = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: ghHeaders,
          body: JSON.stringify({
            name: cleanRepoName,
            private: Boolean(isPrivate),
            description: 'RelayFlow — 多 AI 接力與免費額度排程工作台',
            auto_init: true,
          }),
        });
        const created = (await createRes.json()) as {
          default_branch?: string;
          html_url?: string;
          message?: string;
        };
        if (!createRes.ok) {
          throw new Error(created.message ?? '建立 GitHub Repository 失敗');
        }
        defaultBranch = created.default_branch ?? 'main';
        repoHtmlUrl = created.html_url ?? repoHtmlUrl;
      } else {
        const repoInfoRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepoName}`,
          { headers: ghHeaders }
        );
        const repoInfo = (await repoInfoRes.json()) as {
          default_branch?: string;
          html_url?: string;
          message?: string;
        };
        if (!repoInfoRes.ok) {
          throw new Error(repoInfo.message ?? '找不到指定的 GitHub Repository');
        }
        defaultBranch = repoInfo.default_branch ?? 'main';
        repoHtmlUrl = repoInfo.html_url ?? repoHtmlUrl;
      }

      // Fetch base branch ref with brief retry for newly auto-initialized repos
      let refRes = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/git/ref/heads/${defaultBranch}`,
        { headers: ghHeaders }
      );
      if (!refRes.ok && !useExisting) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await sleep(600);
          refRes = await fetch(
            `https://api.github.com/repos/${owner}/${cleanRepoName}/git/ref/heads/${defaultBranch}`,
            { headers: ghHeaders }
          );
          if (refRes.ok) break;
        }
      }

      // If existing repository is completely empty (0 commits), bootstrap initial commit via Contents API
      if (!refRes.ok && (refRes.status === 404 || refRes.status === 409)) {
        const initRes = await fetch(
          `https://api.github.com/repos/${owner}/${cleanRepoName}/contents/README.md`,
          {
            method: 'PUT',
            headers: ghHeaders,
            body: JSON.stringify({
              message: 'Initialize repository for RelayFlow',
              content: Buffer.from(generateDeployReadme(), 'utf-8').toString('base64'),
              branch: defaultBranch,
            }),
          }
        );
        if (initRes.ok) {
          refRes = await fetch(
            `https://api.github.com/repos/${owner}/${cleanRepoName}/git/ref/heads/${defaultBranch}`,
            { headers: ghHeaders }
          );
        }
      }

      if (!refRes.ok) {
        throw new Error(`Repository 分支 ${defaultBranch} 尚未初始化或無寫入權限`);
      }
      const refData = (await refRes.json()) as { object: { sha: string } };
      const baseCommitSha = refData.object.sha;

      const baseCommitRes = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/git/commits/${baseCommitSha}`,
        { headers: ghHeaders }
      );
      const baseCommitData = (await baseCommitRes.json()) as { tree: { sha: string } };

      const files = await collectProjectFiles(rootDir);

      // Upload blobs in small parallel batches
      const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      const batchSize = 8;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const uploaded = await Promise.all(
          batch.map(async (f) => {
            const blobRes = await fetch(
              `https://api.github.com/repos/${owner}/${cleanRepoName}/git/blobs`,
              {
                method: 'POST',
                headers: ghHeaders,
                body: JSON.stringify({
                  content: f.buffer.toString('base64'),
                  encoding: 'base64',
                }),
              }
            );
            const blobJson = (await blobRes.json()) as { sha?: string; message?: string };
            if (!blobRes.ok || !blobJson.sha) {
              throw new Error(blobJson.message ?? `上傳檔案 ${f.relativePath} 失敗`);
            }
            return {
              path: f.relativePath,
              mode: '100644',
              type: 'blob',
              sha: blobJson.sha,
            };
          })
        );
        treeEntries.push(...uploaded);
      }

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/git/trees`,
        {
          method: 'POST',
          headers: ghHeaders,
          body: JSON.stringify({
            base_tree: baseCommitData.tree.sha,
            tree: treeEntries,
          }),
        }
      );
      const treeJson = (await treeRes.json()) as { sha?: string; message?: string };
      if (!treeRes.ok || !treeJson.sha) {
        throw new Error(treeJson.message ?? '建立 Git Tree 失敗');
      }

      const commitRes = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/git/commits`,
        {
          method: 'POST',
          headers: ghHeaders,
          body: JSON.stringify({
            message: commitMessage?.trim() || 'Deploy RelayFlow app from AI Studio',
            tree: treeJson.sha,
            parents: [baseCommitSha],
          }),
        }
      );
      const commitJson = (await commitRes.json()) as { sha?: string; message?: string };
      if (!commitRes.ok || !commitJson.sha) {
        throw new Error(commitJson.message ?? '建立 Git Commit 失敗');
      }

      const updateRefRes = await fetch(
        `https://api.github.com/repos/${owner}/${cleanRepoName}/git/refs/heads/${defaultBranch}`,
        {
          method: 'PATCH',
          headers: ghHeaders,
          body: JSON.stringify({ sha: commitJson.sha }),
        }
      );
      if (!updateRefRes.ok) {
        throw new Error('更新遠端分支指標失敗');
      }

      const vercelImportUrl = `https://vercel.com/new/clone?repository-url=${encodeURIComponent(
        repoHtmlUrl
      )}&project-name=${encodeURIComponent(cleanRepoName)}&env=GEMINI_API_KEY&envDescription=${encodeURIComponent(
        'Gemini API Key for AI relay planning and preview execution'
      )}`;

      res.json({
        ok: true,
        repoUrl: repoHtmlUrl,
        branch: defaultBranch,
        commitSha: commitJson.sha,
        fileCount: files.length,
        vercelImportUrl,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : '推送至 GitHub 失敗',
      });
    }
  });

  // 5. Vercel OAuth Routes & Direct Deployment API
  app.get('/api/auth/vercel/url', (req: Request, res: Response) => {
    const clientId = process.env.VERCEL_CLIENT_ID;
    const clientSecret = process.env.VERCEL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(503).json({
        error: '尚未於環境設定 VERCEL_CLIENT_ID 與 VERCEL_CLIENT_SECRET；您仍可使用「Personal Access Token」或 Push 到 GitHub 後的「一鍵匯入 Vercel」按鈕。',
      });
      return;
    }

    prunePendingOAuthFlows();
    const baseUrl = resolveAllowedOrigin(req.query.origin);
    const redirectUri = `${baseUrl}/auth/vercel/callback`;
    const state = toBase64Url(crypto.randomBytes(18));

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    });

    if (clientId.startsWith('cl_')) {
      const codeVerifier = toBase64Url(crypto.randomBytes(32));
      const codeChallenge = toBase64Url(
        crypto.createHash('sha256').update(codeVerifier).digest()
      );
      params.set('code_challenge', codeChallenge);
      params.set('code_challenge_method', 'S256');
      pendingOAuthFlows.set(state, { redirectUri, codeVerifier, createdAt: Date.now() });
    } else {
      pendingOAuthFlows.set(state, { redirectUri, createdAt: Date.now() });
    }

    res.json({
      url: `https://vercel.com/oauth/authorize?${params.toString()}`,
      redirectUri,
    });
  });

  const handleVercelCallback = async (req: Request, res: Response) => {
    const oauthError =
      typeof req.query.error_description === 'string'
        ? req.query.error_description
        : typeof req.query.error === 'string'
        ? req.query.error
        : '';
    if (oauthError) {
      res.status(400).send(`<p>Vercel 授權失敗：${oauthError}</p>`);
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = state ? pendingOAuthFlows.get(state) : undefined;
    if (state) pendingOAuthFlows.delete(state);

    const clientId = process.env.VERCEL_CLIENT_ID;
    const clientSecret = process.env.VERCEL_CLIENT_SECRET;

    if (!code || !clientId || !clientSecret) {
      res.status(400).send('<p>Vercel OAuth 授權參數不完整。</p>');
      return;
    }

    const redirectUri = flow?.redirectUri ?? `${getAppBaseUrl()}/auth/vercel/callback`;
    const isModernVercelApp = clientId.startsWith('cl_');
    const tokenEndpoint = isModernVercelApp
      ? 'https://api.vercel.com/login/oauth/token'
      : 'https://api.vercel.com/v2/oauth/access_token';

    try {
      const formBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      if (isModernVercelApp) {
        formBody.set('grant_type', 'authorization_code');
        if (flow?.codeVerifier) {
          formBody.set('code_verifier', flow.codeVerifier);
        }
      }

      const tokenRes = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error_description?: string;
        error?: string;
      };
      if (!tokenData.access_token) {
        throw new Error(
          tokenData.error_description ?? tokenData.error ?? 'Vercel Token 交換失敗'
        );
      }

      res.cookie('rf_vercel_token', tokenData.access_token, getCookieOptions());
      res.send(`<!doctype html><html><body><script>
        if (window.opener) {
          window.opener.postMessage({ type: 'VERCEL_OAUTH_SUCCESS' }, '*');
          window.close();
        } else {
          window.location.href = '/';
        }
      </script><p>Vercel 連結成功，視窗將自動關閉。</p></body></html>`);
    } catch (error) {
      res
        .status(500)
        .send(
          `<p>Vercel 授權失敗：${error instanceof Error ? error.message : '未知錯誤'}</p>`
        );
    }
  };

  app.get(['/auth/vercel/callback', '/auth/vercel/callback/'], handleVercelCallback);

  app.post('/api/vercel/token', async (req: Request, res: Response) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      res.status(400).json({ error: '請輸入有效的 Vercel Access Token。' });
      return;
    }
    try {
      const userRes = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!userRes.ok) {
        res.status(401).json({ error: 'Vercel Token 驗證失敗，請確認 Token 有效且尚未過期。' });
        return;
      }
      const data = (await userRes.json()) as { user?: { username?: string } };
      res.cookie('rf_vercel_token', token, getCookieOptions());
      res.json({ ok: true, username: data.user?.username ?? 'vercel-user' });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : '驗證 Vercel Token 失敗',
      });
    }
  });

  app.get('/api/vercel/status', async (req: Request, res: Response) => {
    const token = req.cookies?.rf_vercel_token as string | undefined;
    if (!token) {
      res.json({ connected: false });
      return;
    }

    try {
      const userRes = await fetch('https://api.vercel.com/v2/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!userRes.ok) {
        res.clearCookie('rf_vercel_token', getCookieOptions());
        res.json({ connected: false });
        return;
      }
      const data = (await userRes.json()) as {
        user?: { username?: string; email?: string };
      };
      res.json({
        connected: true,
        username: data.user?.username ?? 'vercel-user',
        email: data.user?.email ?? '',
      });
    } catch {
      res.json({ connected: false });
    }
  });

  app.post('/api/vercel/disconnect', (_req: Request, res: Response) => {
    res.clearCookie('rf_vercel_token', getCookieOptions());
    res.json({ ok: true });
  });

  app.post('/api/deploy/vercel', async (req: Request, res: Response) => {
    const token = req.cookies?.rf_vercel_token as string | undefined;
    if (!token) {
      res.status(401).json({ error: '尚未連結 Vercel 帳號，請先授權登入 Vercel。' });
      return;
    }

    const { projectName, target } = req.body as {
      projectName?: string;
      target?: 'production' | 'preview';
    };

    const cleanProjectName =
      (projectName ?? 'relayflow-ai')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'relayflow-ai';

    try {
      const files = await collectProjectFiles(rootDir);
      const deployRes = await fetch('https://api.vercel.com/v13/deployments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: cleanProjectName,
          target: target === 'preview' ? undefined : 'production',
          files: files.map((f) => ({
            file: f.relativePath,
            data: f.buffer.toString('base64'),
            encoding: 'base64',
          })),
          projectSettings: {
            framework: 'vite',
            buildCommand: 'npm run build',
            outputDirectory: 'dist',
          },
        }),
      });

      const deployData = (await deployRes.json()) as {
        id?: string;
        url?: string;
        inspectorUrl?: string;
        readyState?: string;
        error?: { message?: string };
      };
      if (!deployRes.ok || !deployData.url) {
        throw new Error(deployData.error?.message ?? 'Vercel 部署建立失敗');
      }

      res.json({
        ok: true,
        deploymentId: deployData.id,
        url: `https://${deployData.url}`,
        inspectorUrl: deployData.inspectorUrl,
        readyState: deployData.readyState ?? 'BUILDING',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Vercel 部署失敗',
      });
    }
  });
}
