import type { AITool, ChannelType, RelayStep, TaskPriority } from '../types';

export interface PlannedStepDraft {
  title: string;
  capabilityTag: string;
  toolId: string;
  preferredChannel?: ChannelType;
  estimatedMinutes: number;
  promptTemplate: string;
  routingReason: string;
}

export function buildLocalRelayPlan(
  goal: string,
  tools: AITool[]
): { suggestedTitle: string; steps: PlannedStepDraft[] } {
  const lower = goal.toLowerCase();
  const isCoding =
    /程式|api|code|重構|bug|演算法|系統|架構|前端|後端|資料庫|test|sql/.test(lower);
  const isVisual = /圖|海報|簡報|視覺|設計|logo|ui|banner|材質|3d/.test(lower);
  const isResearch = /查|市場|競品|新聞|報告|分析|趨勢|論文|資料|輿情|社群/.test(lower);
  const isVoiceOrMeeting = /錄音|語音|會議|逐字稿|通話|紀要|手機/.test(lower);
  const isSocial = /社群|x|twitter|熱度|話題|網友/.test(lower);

  const hasTool = (id: string) => tools.some((t) => t.id === id && t.enabled);
  const pickEnabled = (preferred: string, fallback: string) =>
    hasTool(preferred) ? preferred : hasTool(fallback) ? fallback : tools[0]?.id ?? 'gemini';

  const drafts: PlannedStepDraft[] = [];

  if (isVoiceOrMeeting) {
    const voiceTool = pickEnabled('bixby', 'gemini');
    drafts.push({
      title: '裝置端語音錄音轉錄與初步重點擷取',
      capabilityTag: '語音摘要',
      toolId: voiceTool,
      preferredChannel: 'app',
      estimatedMinutes: 15,
      promptTemplate: `針對「${goal}」，先透過裝置端摘要主要發言重點與待辦項目，不消耗雲端主力額度。`,
      routingReason: 'Samsung Bixby / Galaxy AI App 具備裝置端語音摘要優勢，可節省雲端 AI 次數',
    });
  }

  if (isCoding) {
    drafts.push(
      {
        title: '需求拆解與邊界條件邏輯推演',
        capabilityTag: '深度推理',
        toolId: pickEnabled('deepseek', 'chatgpt'),
        estimatedMinutes: 25,
        promptTemplate: `針對目標「${goal}」，推演核心資料流、潛在併發或邊界錯誤條件，輸出架構檢查清單。`,
        routingReason: 'DeepSeek 擅長演算法與邊界邏輯推導，且 Web/App 免費額度充沛',
      },
      {
        title: '核心程式碼實作與模組重構',
        capabilityTag: '程式設計',
        toolId: pickEnabled('claude', 'chatgpt'),
        estimatedMinutes: 35,
        promptTemplate: '承接上一步架構檢查清單，撰寫乾淨、型別嚴謹且易維護的完整實作程式碼。',
        routingReason: 'Claude 擅長高品質程式結構與嚴謹型別設計',
      },
      {
        title: '單元測試與異常情境驗證腳本',
        capabilityTag: '測試驗證',
        toolId: pickEnabled('copilot', 'chatgpt'),
        estimatedMinutes: 20,
        promptTemplate: '依據上一步實作程式碼，產出涵蓋正常與失敗路徑的自動化測試案例。',
        routingReason: '將收尾測試分流至 Microsoft Copilot / ChatGPT，節省主力模型額度',
      }
    );
  } else {
    if (isResearch) {
      drafts.push({
        title: '即時聯網資料檢索與來源查證',
        capabilityTag: '即時查證',
        toolId: pickEnabled(isSocial ? 'grok' : 'perplexity', 'gemini'),
        estimatedMinutes: 20,
        promptTemplate: `針對「${goal}」，蒐集最新公開數據、關鍵案例與可查證來源摘要。`,
        routingReason: isSocial
          ? 'Grok 具備 X 社群即時輿情與時事洞察優勢'
          : 'Perplexity 具備即時搜尋與引用標註強項',
      });
    }

    drafts.push({
      title: '多維度資訊彙整與結構化大綱',
      capabilityTag: '長文整理',
      toolId: pickEnabled('gemini', 'copilot'),
      estimatedMinutes: 25,
      promptTemplate: '整合任務目標與前序查證摘要，整理成邏輯清晰的結構化大綱與對比重點表。',
      routingReason: 'Google AI Studio 免費額度高且擅長超長上下文消化與表格整理',
    });

    drafts.push({
      title: '精煉成文與語氣風格潤飾定稿',
      capabilityTag: '文案潤飾',
      toolId: pickEnabled('claude', 'chatgpt'),
      estimatedMinutes: 30,
      promptTemplate: '承接上一步結構大綱，撰寫可直接使用的高品質繁體中文成品並統一專業語氣。',
      routingReason: 'Claude 文字表達自然細膩，適合擔任成品潤飾主力',
    });

    if (isVisual) {
      drafts.push({
        title: '視覺配圖概念與生圖提示詞設計',
        capabilityTag: '視覺生成',
        toolId: pickEnabled('leonardo', 'flux'),
        estimatedMinutes: 15,
        promptTemplate: '根據定稿內容的核心主張，設計 2 組可直接於 Leonardo.ai / Flux 生成的圖像提示詞與風格參數。',
        routingReason: '由 Leonardo.ai 每日免費 Tokens 負責高品質概念視覺生成',
      });
    }
  }

  return {
    suggestedTitle: goal.length > 26 ? `${goal.slice(0, 26)}...` : goal,
    steps: drafts,
  };
}

export function draftsToRelaySteps(
  drafts: PlannedStepDraft[],
  tools: AITool[],
  taskIdPrefix: string
): RelayStep[] {
  return drafts.map((d, index) => {
    const tool = tools.find((t) => t.id === d.toolId) ?? tools[0];
    const resolvedChannel: ChannelType =
      d.preferredChannel === 'app' && tool.channels?.app.available
        ? 'app'
        : d.preferredChannel === 'web' && tool.channels?.web.available
        ? 'web'
        : tool.channels && !tool.channels.web.available && tool.channels.app.available
        ? 'app'
        : 'web';
    return {
      id: `${taskIdPrefix}-step-${index + 1}`,
      order: index + 1,
      title: d.title,
      capabilityTag: d.capabilityTag,
      preferredToolId: tool.id,
      assignedToolId: tool.id,
      preferredChannel: d.preferredChannel,
      assignedChannel: resolvedChannel,
      creditCost: tool.costPerStep,
      estimatedMinutes: d.estimatedMinutes,
      promptTemplate: d.promptTemplate,
      status: 'pending',
      scheduledSlot: null,
      output: '',
      routingNote: d.routingReason,
    };
  });
}

export function formatPriorityLabel(priority: TaskPriority): string {
  switch (priority) {
    case 'P1':
      return 'P1 緊急優先';
    case 'P2':
      return 'P2 標準排程';
    case 'P3':
      return 'P3 彈性緩衝';
  }
}
