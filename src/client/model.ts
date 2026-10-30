import type { DashboardResponse, RecoveryPlan } from '../shared/types';
import type { Command } from './api';

export type Page = 'overview' | 'incidents' | 'network' | 'inventory' | 'evidence' | 'collaboration' | 'history';
export type Dialog = { type: 'import' | 'event' | 'document' | 'reset' } | { type: 'plan'; plan: RecoveryPlan; action: 'approve' | 'reject' | 'modify' | 'break_glass' };
export interface ViewProps {
  data: DashboardResponse;
  pending: boolean;
  execute: (command: Command, success?: string) => Promise<boolean>;
  open: (dialog: Dialog) => void;
  navigate: (page: Page, incidentId?: string) => void;
}
