import express, { type Express } from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import cookieParser from 'cookie-parser';
import { registerExportAndDeployRoutes } from './exportAndDeploy.ts';
import { createInitialWorkspaceState, INITIAL_WORKSPACE_STATE } from '../src/data/seedData.ts';
import type { AITool, WorkspaceState } from '../src/types.ts';

let memoryStateFallback: WorkspaceState | null = null;

function resolveStateFilePath(rootDir: string): string {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), 'relayflow-data', 'relayflow-state.json');
  }
  return path.join(rootDir, '.data', 'relayflow-state.json');
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isTransientGeminiError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|timed out|ECONNRESET|fetch failed/i.test(
    msg
  );
}

function formatGeminiErrorMessage(error: unknown, fallbackMessage: string): {
  status: number;
  message: string;
} {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(raw)) {
    return {
      status: 503,
      message: 'Gemini 雲端服務目前處於尖峰負載（暫時不可用），請稍後再試或先使用本地拆解。',
    };
  }
  if (/429|RESOURCE_EXHAUSTED/i.test(raw)) {
    return {
      status: 429,
      message: 'Gemini API 目前達到請求速率上限，請稍候再試。',
    };
  }
  if (/403|PERMISSION_DENIED|400|API_KEY_INVALID/i.test(raw)) {
    return {
      status: 400,
      message: 'Gemini API 金鑰無效或權限不足，請檢查 Secrets 設定。',
    };
  }
  return {
    status: 500,
    message: raw && !raw.trim().startsWith('{') ? raw : fallbackMessage,
  };
}

async function generateWithRetryAndFallback(
  ai: GoogleGenAI,
  buildParams: (model: string, isLiteFallback: boolean) => Parameters<typeof ai.models.generateContent>[0]
) {
  const primaryModel = 'gemini-4-hydrogen';
  const fallbackModel = 'gemini-3.1-flash-lite';
  const delays = [600, 1400];

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await ai.models.generateContent(buildParams(primaryModel, false));
    } catch (err) {
      lastError = err;
      if (!isTransientGeminiError(err) || attempt === delays.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }

  if (isTransientGeminiError(lastError)) {
    try {
      return await ai.models.generateContent(buildParams(fallbackModel, true));
    } catch (fallbackErr) {
      lastError = fallbackErr;
    }
  }

  throw lastError;
}

async function readSavedState(stateFile: string): Promise<WorkspaceState> {
  if (memoryStateFallback) {
    return memoryStateFallback;
  }
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as WorkspaceState;
    memoryStateFallback = parsed;
    return parsed;
  } catch {
    const freshSeed = createInitialWorkspaceState();
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(freshSeed, null, 2), 'utf-8');
    } catch {
      // Ignore read-only filesystem errors in serverless environments
    }
    memoryStateFallback = freshSeed;
    return freshSeed;
  }
}

async function writeSavedState(stateFile: string, state: WorkspaceState): Promise<void> {
  memoryStateFallback = state;
  try {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Keep in-memory state when running on read-only serverless filesystem
  }
}

interface ToolProbeTarget {
  id: string;
  name: string;
  officialUrl: string;
}

async function probeSingleToolUrl(target: ToolProbeTarget): Promise<{
  id: string;
  name: string;
  url: string;
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  note: string;
}> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(target.officialUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; RelayFlow-HealthCheck/1.0; +https://vercel.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const latencyMs = Date.now() - startedAt;
    // Many AI services (Cloudflare/bot protection) return 403/405/429 to automated probes while the domain & TLS endpoint are live.
    const isLiveHttp = res.status >= 200 && res.status < 500;
    return {
      id: target.id,
      name: target.name,
      url: target.officialUrl,
      reachable: isLiveHttp,
      statusCode: res.status,
      latencyMs,
      note:
        res.status >= 200 && res.status < 400
          ? `連線正常 (HTTP ${res.status})`
          : res.status === 403 || res.status === 405 || res.status === 429
          ? `端點在線（瀏覽器防爬蟲保護 HTTP ${res.status}，手動點擊開啟正常）`
          : `回應異常 (HTTP ${res.status})`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      id: target.id,
      name: target.name,
      url: target.officialUrl,
      reachable: false,
      statusCode: null,
      latencyMs,
      note:
        error instanceof Error && error.name === 'AbortError'
          ? '連線逾時 (>5000ms)'
          : error instanceof Error
          ? error.message
          : '無法連線至外部網域',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createApiApp(rootDir: string): Express {
  const app = express();
  const stateFile = resolveStateFilePath(rootDir);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  registerExportAndDeployRoutes(app, rootDir);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasGeminiKey: Boolean(getGeminiClient()),
      runtime: process.env.VERCEL ? 'vercel-serverless' : 'node-express',
    });
  });

  app.get('/api/state', async (_req, res) => {
    try {
      const state = await readSavedState(stateFile);
      res.json(state);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '無法讀取工作區狀態' });
    }
  });

  app.put('/api/state', async (req, res) => {
    try {
      const nextState = req.body as WorkspaceState;
      if (!nextState || !Array.isArray(nextState.tools) || !Array.isArray(nextState.tasks)) {
        res.status(400).json({ error: '無效的工作區資料結構' });
        return;
      }
      await writeSavedState(stateFile, nextState);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '無法儲存工作區狀態' });
    }
  });

  app.post('/api/state/reset', async (_req, res) => {
    try {
      const freshSeed = createInitialWorkspaceState();
      await writeSavedState(stateFile, freshSeed);
      res.json(freshSeed);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '重設工作區失敗' });
    }
  });

  app.post('/api/tools/test', async (req, res) => {
    const { tools } = req.body as { tools?: ToolProbeTarget[] };
    const targets: ToolProbeTarget[] =
      Array.isArray(tools) && tools.length > 0
        ? tools
            .filter((t) => t && typeof t.id === 'string' && typeof t.officialUrl === 'string')
            .slice(0, 30)
        : INITIAL_WORKSPACE_STATE.tools.map((t) => ({
            id: t.id,
            name: t.name,
            officialUrl: t.officialUrl,
          }));

    try {
      const results = await Promise.all(targets.map((target) => probeSingleToolUrl(target)));
      res.json({
        ok: true,
        testedAt: new Date().toISOString(),
        geminiConfigured: Boolean(getGeminiClient()),
        results,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'AI 工具連線測試失敗',
      });
    }
  });

  app.post('/api/relay/plan', async (req, res) => {
    const { goal, title, priority, tools } = req.body as {
      goal?: string;
      title?: string;
      priority?: string;
      tools?: AITool[];
    };

    if (!goal || typeof goal !== 'string') {
      res.status(400).json({ error: '請提供任務目標描述' });
      return;
    }

    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          '尚未設定 GEMINI_API_KEY，無法呼叫智慧接力拆解服務，請改用本地規則拆解或於 Secrets 設定金鑰。',
      });
      return;
    }

    try {
      const enabledTools = (tools ?? INITIAL_WORKSPACE_STATE.tools)
        .filter((t) => t.enabled)
        .map((t) => {
          const webRem = t.channels?.web.available
            ? Math.max(0, t.channels.web.dailyLimit * (t.accountCount ?? 1) - t.channels.web.usedToday)
            : 0;
          const appRem = t.channels?.app.available
            ? Math.max(0, t.channels.app.dailyLimit * (t.accountCount ?? 1) - t.channels.app.usedToday)
            : 0;
          return {
            id: t.id,
            name: t.name,
            strengths: t.strengths,
            remainingCredits: Math.max(0, t.dailyLimit - t.usedToday),
            webRemaining: webRem,
            appRemaining: appRem,
            webAvailable: t.channels?.web.available ?? true,
            appAvailable: t.channels?.app.available ?? false,
            isSharedQuota: t.channels?.app.isSharedQuota ?? false,
            costPerStep: t.costPerStep,
          };
        });

      const prompt = `
你是一位精通「多 AI 工具接力編排與 Web/App 免費額度最佳化」的工作流架構師。
使用者提出了一個任務目標，請將它拆解為 3 到 4 個「前後接力（Step N 產出交棒給 Step N+1）」的執行步驟，並為每一步挑選最適合的 AI 工具 ID 與建議執行通道（web 或 app）。

任務標題：${title || '未命名任務'}
任務目標：${goal}
優先等級：${priority || 'P2'}

目前可用的 AI 工具與今日 Web / App 剩餘免費額度：
${JSON.stringify(enabledTools, null, 2)}

拆解與分流原則：
1. 必須善用每個模型的真實強項：即時查證選 perplexity，X 即時輿情選 grok，長上下文彙整選 gemini，精準長文潤飾或架構程式碼選 claude，邏輯併發推理選 deepseek，企劃或測試選 chatgpt / copilot，視覺生圖選 leonardo 或 flux，手機錄音或語音前處理選 bixby（僅有 app 通道）。
2. 善用跨 Web 與 App 雙端額度：若某工具網頁版額度偏低但有獨立 App 額度，或適合行動裝置語音/截圖處理，可建議 preferredChannel 為 "app"；否則建議 "web"。
3. 若該工具今日剩餘額度為 0，盡量分流給備援模型，或於 routingReason 中明確標註為何仍指定它。
4. 每一步的 promptTemplate 必須清楚說明要如何承接「上一步的輸出上下文」。
5. 全程使用繁體中文。
`;

      const response = await generateWithRetryAndFallback(ai, (model, isLiteFallback) => ({
        model,
        contents: prompt,
        config: {
          ...(isLiteFallback
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          systemInstruction:
            '請只輸出符合 Schema 的 JSON 結構，必須包含 suggestedTitle 與 3 到 4 個 steps 陣列項目，不要省略 steps，不要包含額外解說文字。',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            required: ['suggestedTitle', 'steps'],
            properties: {
              suggestedTitle: {
                type: Type.STRING,
                description: '精煉後的任務標題（繁體中文）',
              },
              steps: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  required: [
                    'title',
                    'capabilityTag',
                    'toolId',
                    'preferredChannel',
                    'estimatedMinutes',
                    'promptTemplate',
                    'routingReason',
                  ],
                  properties: {
                    title: { type: Type.STRING, description: '步驟名稱' },
                    capabilityTag: {
                      type: Type.STRING,
                      description:
                        '兩到四字能力標籤，如 即時查證、長文整理、深度推理、程式設計、文案潤飾、視覺生成、語音摘要',
                    },
                    toolId: {
                      type: Type.STRING,
                      description: '必須對應可用工具清單中的 id 之一',
                    },
                    preferredChannel: {
                      type: Type.STRING,
                      description: '建議執行端：web 或 app',
                    },
                    estimatedMinutes: { type: Type.INTEGER, description: '預估耗時分鐘數 (10-45)' },
                    promptTemplate: { type: Type.STRING, description: '包含上下文交棒指引的提示詞模板' },
                    routingReason: { type: Type.STRING, description: '選擇此 AI 工具與執行端的理由' },
                  },
                },
              },
            },
          },
        },
      }));

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        suggestedTitle?: string;
        steps?: Array<{
          title?: string;
          capabilityTag?: string;
          toolId?: string;
          preferredChannel?: string;
          estimatedMinutes?: number;
          promptTemplate?: string;
          routingReason?: string;
        }>;
      };

      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        res.status(502).json({
          error: 'AI 拆解未回傳步驟陣列，已由本地規則備援拆解。',
        });
        return;
      }

      const validIds = new Set((tools ?? INITIAL_WORKSPACE_STATE.tools).map((t) => t.id));
      const fallbackId = enabledTools[0]?.id ?? 'gemini';
      const sanitizedSteps = parsed.steps.map((s) => ({
        title: s.title || '接力步驟',
        capabilityTag: s.capabilityTag || '任務接力',
        toolId: s.toolId && validIds.has(s.toolId) ? s.toolId : fallbackId,
        preferredChannel: s.preferredChannel === 'app' ? 'app' : 'web',
        estimatedMinutes:
          typeof s.estimatedMinutes === 'number' && s.estimatedMinutes > 0
            ? Math.min(60, Math.max(10, Math.round(s.estimatedMinutes)))
            : 20,
        promptTemplate: s.promptTemplate || '承接上一步輸出並完成此階段交付。',
        routingReason: s.routingReason || '依模型強項與剩餘額度指派',
      }));

      res.json({
        suggestedTitle: parsed.suggestedTitle || title || '多 AI 接力任務',
        steps: sanitizedSteps,
      });
    } catch (error) {
      console.error('Gemini plan error:', error);
      const formatted = formatGeminiErrorMessage(error, '智慧拆解失敗，請稍後再試');
      res.status(formatted.status).json({
        error: formatted.message,
      });
    }
  });

  app.post('/api/relay/execute', async (req, res) => {
    const {
      taskTitle,
      taskGoal,
      stepTitle,
      capabilityTag,
      assignedToolName,
      toolStrengths,
      promptTemplate,
      previousOutputs,
    } = req.body as {
      taskTitle?: string;
      taskGoal?: string;
      stepTitle?: string;
      capabilityTag?: string;
      assignedToolName?: string;
      toolStrengths?: string[];
      promptTemplate?: string;
      previousOutputs?: Array<{
        stepTitle: string;
        toolName: string;
        channelLabel?: string;
        output: string;
      }>;
    };

    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          '尚未設定 GEMINI_API_KEY，無法於工作台直接生成預演產出；您仍可使用「複製交棒提示詞」至外部 AI 並貼回結果。',
      });
      return;
    }

    try {
      const handoffContext =
        previousOutputs && previousOutputs.length > 0
          ? previousOutputs
              .map(
                (item, idx) =>
                  `[前序步驟 ${idx + 1} · ${item.toolName}${
                    item.channelLabel ? ` (${item.channelLabel})` : ''
                  }｜${item.stepTitle}]\n${item.output}`
              )
              .join('\n\n---\n\n')
          : '（此為接力任務的第一步，尚無前序產出）';

      const prompt = `
你現在正在協助執行一個多 AI 接力任務中的特定階段。
總任務標題：${taskTitle}
總任務目標：${taskGoal}

目前執行步驟：${stepTitle}
能力定位：${capabilityTag}
本步驟指派工具定位：${assignedToolName}（強項：${(toolStrengths ?? []).join('、')}）

【前序接力上下文（上一步 AI 的產出）】
${handoffContext}

【本步驟執行指令】
${promptTemplate}

請直接產出該步驟高品質、結構化、可供下一步 AI 直接接手使用的繁體中文成果（約 250-500 字，條列或表格皆可，不需寒暄開場白）。
`;

      const response = await generateWithRetryAndFallback(ai, (model, isLiteFallback) => ({
        model,
        contents: prompt,
        config: {
          ...(isLiteFallback
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          systemInstruction:
            '你是精準高效的任務接力執行引擎，請嚴格承接上一步提供的脈絡並產出可直接交付下一步驟的結構化繁體中文結果。',
        },
      }));

      res.json({ output: (response.text ?? '').trim() });
    } catch (error) {
      console.error('Gemini execute error:', error);
      const formatted = formatGeminiErrorMessage(error, '執行接力步驟時發生錯誤');
      res.status(formatted.status).json({
        error: formatted.message,
      });
    }
  });

  app.post('/api/relay/finalize', async (req, res) => {
    const { taskTitle, taskGoal, stepOutputs } = req.body as {
      taskTitle?: string;
      taskGoal?: string;
      stepOutputs?: Array<{
        order: number;
        stepTitle: string;
        toolName: string;
        channelLabel?: string;
        output: string;
      }>;
    };

    if (!Array.isArray(stepOutputs) || stepOutputs.length === 0) {
      res.status(400).json({ error: '缺少步驟產出資料' });
      return;
    }

    const combinedFallback = stepOutputs
      .map(
        (s) =>
          `### 第 ${s.order} 棒｜${s.stepTitle}（${s.toolName}${
            s.channelLabel ? ` · ${s.channelLabel}` : ''
          }）\n\n${s.output}`
      )
      .join('\n\n---\n\n');

    const ai = getGeminiClient();
    if (!ai) {
      res.json({ deliverable: combinedFallback, fallback: true });
      return;
    }

    try {
      const prompt = `
你是一位專業總編輯，負責將「多 AI 接力任務」各步驟的產出整合成一份結構完整、可直接交付使用的最終報告／成品。

任務標題：${taskTitle || '多 AI 接力任務'}
最終目標：${taskGoal || ''}

【各步驟接力產出】
${combinedFallback}

請用繁體中文直接整合出一份條理分明、消除重複內容、保留所有關鍵數據／結論／程式碼或提示詞的最終交付成果（使用 Markdown 小標與條列，不要寒暄）。
`;

      const response = await generateWithRetryAndFallback(ai, (model, isLiteFallback) => ({
        model,
        contents: prompt,
        config: {
          ...(isLiteFallback
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
          systemInstruction: '將多步驟接力成果彙整為結構清楚、可直接交付的繁體中文 Markdown 成品。',
        },
      }));

      res.json({ deliverable: (response.text ?? '').trim() || combinedFallback });
    } catch {
      res.json({ deliverable: combinedFallback, fallback: true });
    }
  });

  return app;
}
