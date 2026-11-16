export type ToolCategory =
  | 'research'
  | 'reasoning'
  | 'writing'
  | 'coding'
  | 'multimodal'
  | 'visual';

export type ChannelType = 'web' | 'app';

export type PreferredChannelMode = 'auto' | 'web' | 'app';

export type RoutingMode = 'strength_first' | 'quota_balanced' | 'urgency_first';

export type TaskPriority = 'P1' | 'P2' | 'P3';

export type StepStatus = 'pending' | 'scheduled' | 'in_progress' | 'completed' | 'stashed';

export type TaskStatus = 'active' | 'scheduled' | 'stashed' | 'completed';

export interface WebChannelConfig {
  available: boolean;
  dailyLimit: number;
  usedToday: number;
  notes: string;
}

export interface AppChannelConfig {
  available: boolean;
  dailyLimit: number;
  usedToday: number;
  platformLabel: string;
  isSharedQuota: boolean;
  notes: string;
}

export interface AITool {
  id: string;
  name: string;
  provider: string;
  modelLabel: string;
  category: ToolCategory;
  strengths: string[];
  dailyLimit: number;
  usedToday: number;
  unitLabel: string;
  resetRule: string;
  resetHoursRemaining: number;
  costPerStep: number;
  enabled: boolean;
  fallbackToolIds: string[];
  officialUrl: string;
  preferredChannel?: PreferredChannelMode;
  accountCount?: number;
  channels?: {
    web: WebChannelConfig;
    app: AppChannelConfig;
  };
}

export interface RelayStep {
  id: string;
  order: number;
  title: string;
  capabilityTag: string;
  preferredToolId: string;
  assignedToolId: string;
  preferredChannel?: ChannelType;
  assignedChannel?: ChannelType;
  creditCost: number;
  estimatedMinutes: number;
  promptTemplate: string;
  status: StepStatus;
  scheduledSlot: string | null;
  output: string;
  routingNote: string;
  startedAt?: string;
  completedAt?: string;
  executionMode?: 'auto' | 'manual';
}

export interface RelayTask {
  id: string;
  title: string;
  goal: string;
  priority: TaskPriority;
  deadlineDate: string;
  createdDate: string;
  daysCarriedOver: number;
  carryoverScore: number;
  status: TaskStatus;
  steps: RelayStep[];
  autoStashReason: string | null;
  updatedAt?: string;
  completedAt?: string;
  finalDeliverable?: string;
}

export interface CarryoverLog {
  id: string;
  fromDate: string;
  toDate: string;
  stashedCount: number;
  completedCount: number;
  summary: string;
  reorderedTitles: string[];
}

export interface LinkedAccount {
  id: string;
  ownerId: string;
  label: string;
  emailAlias: string;
  toolIds: string[];
  notes: string;
  enabled: boolean;
}

export interface WorkspaceState {
  currentDate: string;
  routingMode: RoutingMode;
  dailyTimeBudgetMinutes: number;
  tools: AITool[];
  tasks: RelayTask[];
  carryoverLogs: CarryoverLog[];
}

export interface AutoRelayStatus {
  taskId: string;
  currentStepId: string;
  currentStepOrder: number;
  totalSteps: number;
  currentToolName: string;
  phase: 'executing_step' | 'finalizing';
  error: string | null;
}
