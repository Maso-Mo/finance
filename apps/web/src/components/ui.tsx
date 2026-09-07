import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

/** Fusionne des noms de classes. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* =============================================================
 * Boutons
 * ============================================================= */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        variant === 'primary' && 'btn-primary',
        variant === 'secondary' && 'btn-secondary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        className,
      )}
      {...rest}
    />
  );
}

/* =============================================================
 * Panneaux / cartes
 * ============================================================= */

export function Panel({
  className,
  children,
  ...rest
}: {
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className'>) {
  return (
    <section className={cx('card', className)} {...rest}>
      {children}
    </section>
  );
}

/** Panneau avec titre + sous-titre + zone d'actions optionnelle. */
export function SectionCard({
  title,
  subtitle,
  aside,
  children,
  className,
  id,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cx('card', 'p-5 sm:p-6', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink sm:text-base">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-ink2">
              {subtitle}
            </p>
          ) : null}
        </div>
        {aside ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** En-tête de page : titre très lisible + actions principales à droite. */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        'mb-5 flex flex-wrap items-start justify-between gap-3 sm:mb-6',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[28px]">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-sm text-ink2">{subtitle}</p> : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/* =============================================================
 * Badges / pastilles
 * ============================================================= */

export function BadgeVert({ children = 'Vert' }: { children?: ReactNode }) {
  return <span className="badge-vert">{children}</span>;
}

export function BadgeDepasse({ children = 'Dépassé' }: { children?: ReactNode }) {
  return <span className="badge-depasse">{children}</span>;
}

export function BadgeSoft({ children }: { children: ReactNode }) {
  return <span className="badge-soft">{children}</span>;
}

/* =============================================================
 * Barre de progression
 * ============================================================= */

type BarTone = 'brand' | 'positive' | 'danger' | 'violet';

const BAR_TONE: Record<BarTone, string> = {
  brand: 'var(--brand)',
  positive: 'var(--positive)',
  danger: 'var(--danger)',
  violet: 'var(--violet)',
};

export function ProgressBar({
  ratio,
  tone = 'brand',
  className,
}: {
  /** 0…1 (ou plus : la barre est pleine, la couleur reste honnête). */
  ratio: number;
  tone?: BarTone;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return (
    <div
      className={cx('track', className)}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{
          width: `${Math.round(clamped * 100)}%`,
          backgroundColor: BAR_TONE[tone],
        }}
      />
    </div>
  );
}

/** Anneau de progression simple (SVG pur, reduced-motion respecté). */
export function Ring({
  ratio,
  size = 112,
  strokeWidth = 12,
  tone = 'brand',
  children,
}: {
  ratio: number;
  size?: number;
  strokeWidth?: number;
  tone?: BarTone;
  children?: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped);
  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={BAR_TONE[tone]}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}

/* =============================================================
 * Petites briques d'information
 * ============================================================= */

/** Libellé discret + valeur monétaire importante. */
export function Metric({
  label,
  value,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'positive' | 'negative' | 'brand';
  className?: string;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <p className="text-xs font-medium text-ink2">{label}</p>
      <p
        className={cx(
          'mt-0.5 truncate text-lg font-bold tracking-tight num text-ink sm:text-xl',
          tone === 'positive' && 'money-pos',
          tone === 'negative' && 'money-neg',
          tone === 'brand' && 'text-brand-strong',
        )}
      >
        {value}
      </p>
    </div>
  );
}

/* =============================================================
 * Icône dans une pastille colorée (avatar d'opération)
 * ============================================================= */

export function IconBadge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl',
        className,
      )}
    >
      {children}
    </span>
  );
}

