import type { AITool, ChannelType, LinkedAccount } from '../types';

export interface ToolEffectiveSummary {
  accountCount: number;
  webAvailable: boolean;
  appAvailable: boolean;
  isSharedQuota: boolean;
  webLimit: number;
  webUsed: number;
  webRemaining: number;
  appLimit: number;
  appUsed: number;
  appRemaining: number;
  totalLimit: number;
  totalUsed: number;
  totalRemaining: number;
  evaluationVerdict: string;
}

export function getToolEffectiveSummary(
  tool: AITool,
  linkedAccounts: LinkedAccount[] = []
): ToolEffectiveSummary {
  const activeExtraAccounts = linkedAccounts.filter(
    (acc) => acc.enabled && acc.toolIds.includes(tool.id)
  ).length;
  const accountCount = Math.max(1, (tool.accountCount ?? 1) + activeExtraAccounts);

  const webCfg = tool.channels?.web ?? {
    available: true,
    dailyLimit: tool.dailyLimit,
    usedToday: tool.usedToday,
    notes: '網頁版標準免費額度',
  };

  const appCfg = tool.channels?.app ?? {
    available: false,
    dailyLimit: 0,
    usedToday: 0,
    platformLabel: '無獨立 App 額度',
    isSharedQuota: false,
    notes: '僅提供網頁端',
  };

  const webLimit = webCfg.available ? webCfg.dailyLimit * accountCount : 0;
  const webUsed = webCfg.available ? Math.min(webLimit, webCfg.usedToday) : 0;

  const appLimit = appCfg.available ? appCfg.dailyLimit * accountCount : 0;
  const appUsed = appCfg.available ? Math.min(appLimit, appCfg.usedToday) : 0;

  let totalLimit: number;
  let totalUsed: number;
  let webRemaining: number;
  let appRemaining: number;
  let evaluationVerdict: string;

  if (appCfg.available && appCfg.isSharedQuota) {
    totalLimit = Math.max(webLimit, appLimit);
    totalUsed = Math.min(totalLimit, webUsed + appUsed);
    const sharedRem = Math.max(0, totalLimit - totalUsed);
    webRemaining = webCfg.available ? sharedRem : 0;
    appRemaining = sharedRem;
    evaluationVerdict =
      '共享帳號額度池：網頁版與 App 版共用總額，建議以電腦網頁版主力創作、App 版行動預覽。';
  } else if (webCfg.available && appCfg.available) {
    totalLimit = webLimit + appLimit;
    totalUsed = webUsed + appUsed;
    webRemaining = Math.max(0, webLimit - webUsed);
    appRemaining = Math.max(0, appLimit - appUsed);
    evaluationVerdict = `雙端獨立額度池：併用 App 版每日可額外增加 +${appLimit} ${tool.unitLabel}。`;
  } else if (!webCfg.available && appCfg.available) {
    totalLimit = appLimit;
    totalUsed = appUsed;
    webRemaining = 0;
    appRemaining = Math.max(0, appLimit - appUsed);
    evaluationVerdict =
      'App / 裝置端專用：不消耗雲端網頁額度，極適合擔任語音筆記與隨手摘要前置分流。';
  } else {
    totalLimit = webLimit;
    totalUsed = webUsed;
    webRemaining = Math.max(0, webLimit - webUsed);
    appRemaining = 0;
    evaluationVerdict = '網頁版限定：建議作為精準文字或最終收尾步驟。';
  }

  const totalRemaining = Math.max(0, totalLimit - totalUsed);

  return {
    accountCount,
    webAvailable: webCfg.available,
    appAvailable: appCfg.available,
    isSharedQuota: appCfg.isSharedQuota,
    webLimit,
    webUsed,
    webRemaining,
    appLimit,
    appUsed,
    appRemaining,
    totalLimit,
    totalUsed,
    totalRemaining,
    evaluationVerdict,
  };
}

export function normalizeToolWithSummary(
  tool: AITool,
  linkedAccounts: LinkedAccount[] = []
): AITool {
  const summary = getToolEffectiveSummary(tool, linkedAccounts);
  return {
    ...tool,
    dailyLimit: summary.totalLimit,
    usedToday: summary.totalUsed,
  };
}

export function deductToolChannelCredit(
  tool: AITool,
  cost: number,
  channel: ChannelType,
  linkedAccounts: LinkedAccount[] = []
): AITool {
  const summary = getToolEffectiveSummary(tool, linkedAccounts);
  if (!tool.channels) {
    return {
      ...tool,
      usedToday: Math.min(summary.totalLimit, tool.usedToday + cost),
    };
  }

  const nextWeb = { ...tool.channels.web };
  const nextApp = { ...tool.channels.app };

  if (channel === 'app' && nextApp.available) {
    nextApp.usedToday = Math.min(summary.isSharedQuota ? summary.totalLimit : summary.appLimit, nextApp.usedToday + cost);
  } else if (nextWeb.available) {
    nextWeb.usedToday = Math.min(summary.webLimit, nextWeb.usedToday + cost);
  } else if (nextApp.available) {
    nextApp.usedToday = Math.min(summary.appLimit, nextApp.usedToday + cost);
  }

  const updated: AITool = {
    ...tool,
    channels: { web: nextWeb, app: nextApp },
  };
  return normalizeToolWithSummary(updated, linkedAccounts);
}
