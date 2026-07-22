import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, AlertCircle, Loader2, CheckCircle2, ClockArrowUp, XCircle } from 'lucide-react';
import type { CommandStatus } from '@/hooks/useDeviceData';

interface DevicePageHeaderAction {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'destructive';
  className?: string;
}

interface DevicePageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: DevicePageHeaderAction[];
  refresh?: () => void;
  loading?: boolean;
  badge?: {
    label: string;
    variant?: 'default' | 'secondary' | 'destructive' | 'outline';
    className?: string;
  };
  commandStatus?: CommandStatus;
}

const commandStatusConfig: Record<CommandStatus, { label: string; icon: LucideIcon; className: string }> = {
  idle: { label: '', icon: CheckCircle2, className: '' },
  sending: { label: 'Sending...', icon: Loader2, className: 'border-blue-400/30 text-blue-500 bg-blue-500/5' },
  sent: { label: 'Sent', icon: CheckCircle2, className: 'border-success/30 text-success bg-success/5' },
  queued: { label: 'Queued', icon: ClockArrowUp, className: 'border-warning/30 text-warning bg-warning/5' },
  error: { label: 'Failed', icon: XCircle, className: 'border-destructive/30 text-destructive bg-destructive/5' },
};

export function DevicePageHeader({
  title,
  subtitle,
  actions = [],
  refresh,
  loading = false,
  badge,
  commandStatus = 'idle',
}: DevicePageHeaderProps) {
  const statusCfg = commandStatusConfig[commandStatus];
  const busy = loading || commandStatus === 'sending';

  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold">{title}</h3>
              {badge && (
                <Badge variant={badge.variant ?? 'secondary'} className={badge.className}>
                  {badge.label}
                </Badge>
              )}
              {commandStatus !== 'idle' && statusCfg.label && (
                <Badge
                  variant="outline"
                  className={statusCfg.className}
                >
                  <statusCfg.icon className={`h-3 w-3 mr-1 ${commandStatus === 'sending' ? 'animate-spin' : ''}`} />
                  {statusCfg.label}
                </Badge>
              )}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {actions.map((action, i) => (
            <Button
              key={action.label || i}
              onClick={action.onClick}
              disabled={busy || action.disabled}
              variant={action.variant ?? 'default'}
              size="sm"
              className={action.className}
            >
              {action.icon && <action.icon className={`h-3.5 w-3.5 mr-1.5 ${busy ? 'animate-pulse' : ''}`} />}
              {action.label}
            </Button>
          ))}
          {refresh && (
            <Button
              onClick={refresh}
              variant="outline"
              disabled={busy}
              size="sm"
              className="px-2"
              aria-label="Refresh data"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
  };
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <Card>
      <CardContent className="py-12 text-center" role="status">
        <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-muted/50 flex items-center justify-center">
          <Icon className="h-6 w-6 text-muted-foreground/40" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {description && (
          <p className="text-xs text-muted-foreground/50 mt-1 max-w-xs mx-auto">{description}</p>
        )}
        {action && (
          <Button
            onClick={action.onClick}
            disabled={action.disabled || action.loading}
            variant="outline"
            size="sm"
            className="mt-4"
          >
            {action.label}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

interface LoadingSkeletonProps {
  rows?: number;
  variant?: 'table' | 'cards';
}

export function LoadingSkeleton({ rows = 5, variant = 'table' }: LoadingSkeletonProps) {
  if (variant === 'cards') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <Card key={i}>
            <CardContent className="p-2.5">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-muted animate-pulse shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="h-3 w-3/4 bg-muted rounded animate-pulse" />
                  <div className="h-2.5 w-1/2 bg-muted rounded animate-pulse" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <Card>
      <div className="p-0">
        <div className="flex items-center gap-4 px-4 py-3 border-b">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-3 bg-muted rounded animate-pulse flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
            {Array.from({ length: 4 }, (_, j) => (
              <div
                key={j}
                className="h-3 bg-muted rounded animate-pulse flex-1"
                style={{ width: `${((i * 4 + j + 1) * 16) % 40 + 60}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

interface ErrorAlertProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorAlert({ message, onRetry }: ErrorAlertProps) {
  return (
    <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2" role="alert">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button onClick={onRetry} variant="ghost" size="sm" className="h-7 text-xs hover:text-destructive">
          Retry
        </Button>
      )}
    </div>
  );
}

interface StatusBadgeProps {
  label: string;
  status: 'success' | 'warning' | 'danger' | 'neutral';
}

const statusBadgeStyles: Record<StatusBadgeProps['status'], string> = {
  success: 'border-success/30 text-success bg-success/5',
  warning: 'border-warning/30 text-warning bg-warning/5',
  danger: 'border-destructive/30 text-destructive bg-destructive/5',
  neutral: '',
};

export function StatusBadge({ label, status }: StatusBadgeProps) {
  return (
    <Badge variant="outline" className={statusBadgeStyles[status]}>
      {label}
    </Badge>
  );
}

interface SectionCardProps {
  title?: string;
  icon?: LucideIcon;
  children: ReactNode;
  actions?: ReactNode;
}

export function SectionCard({ title, icon: Icon, children, actions }: SectionCardProps) {
  return (
    <Card>
      {(title || actions) && (
        <div className="flex items-center justify-between py-2.5 px-3.5 border-b">
          <div className="flex items-center gap-2 text-sm font-medium">
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {title}
          </div>
          {actions}
        </div>
      )}
      <div className="p-3.5">{children}</div>
    </Card>
  );
}

interface GridItemCardProps {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  onClick?: () => void;
}

export function GridItemCard({ icon, title, subtitle, badge, onClick }: GridItemCardProps) {
  return (
    <Card
      className={`${onClick ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}
      onClick={onClick}
    >
      <CardContent className="p-2.5">
        <div className="flex items-center gap-2.5">
          {icon && (
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              {icon}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">{title}</p>
            {subtitle && (
              <p className="text-[10px] text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>
          {badge}
        </div>
      </CardContent>
    </Card>
  );
}
