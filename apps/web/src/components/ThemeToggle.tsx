import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme';

/**
 * Switch horizontal de thème Clair / Sombre.
 *
 * - Clic / tap sur le switch ou le bouton → bascule.
 * - Glissement (drag / swipe) du bouton via pointer events → bascule selon la
 *   position finale ou le seuil franchi ; pas de changement instable pendant
 *   le drag, pas de clic « fantôme » après un drag.
 * - Clavier : role="switch", Space et Enter basculent.
 * - Accessibilité : bouton focusable, état checked exposé, label visible et
 *   aria-label, icônes soleil/lune (le sens n'est pas porté uniquement par la
 *   couleur).
 *
 * AUCUNE option « Système » n'existe dans l'interface : sans choix explicite,
 * l'application suit le système (voir theme.tsx).
 */

const SWITCH_WIDTH = 56;
const KNOB_DIAMETER = 24;
const PADDING = 4;
const TRAVEL = SWITCH_WIDTH - KNOB_DIAMETER - PADDING * 2;
/** Au-delà de ce déplacement (px) le geste est un drag, pas un clic. */
const DRAG_THRESHOLD = 4;

interface ThemeToggleProps {
  /** Afficher ou non le libellé textuel à côté du switch. */
  showLabel?: boolean;
}

export function ThemeToggle({ showLabel = true }: ThemeToggleProps) {
  const { resolved, setChoice } = useTheme();
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{
    pointerId: number;
    x: number;
    fromDark: boolean;
    moved: boolean;
  } | null>(null);
  const suppressedClick = useRef(false);

  const isDark = resolved === 'dark';

  // Si le thème change (raccourci, autre onglet), on abandonne le drag en cours.
  useEffect(() => {
    if (dragOffset !== null) {
      setDragOffset(null);
      setDragging(false);
      dragStart.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark]);

  const toggle = () => setChoice(isDark ? 'light' : 'dark');

  const knobPosition =
    dragOffset !== null
      ? Math.max(0, Math.min(TRAVEL, dragOffset))
      : isDark
        ? TRAVEL
        : 0;

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    dragStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      fromDark: isDark,
      moved: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = event.clientX - start.x;
    if (Math.abs(delta) >= DRAG_THRESHOLD) {
      start.moved = true;
    }
    const base = start.fromDark ? TRAVEL : 0;
    setDragOffset(Math.max(0, Math.min(TRAVEL, base + delta)));
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStart.current;
    if (!start) return;
    const finalOffset =
      dragOffset !== null ? dragOffset : start.fromDark ? TRAVEL : 0;
    const wasDrag = start.moved;

    if (wasDrag) {
      // Seuil : si le bouton a parcouru plus de la moitié de la piste, on
      // bascule vers l'autre côté ; sinon on revient au thème de départ.
      const targetDark =
        finalOffset >= TRAVEL / 2 ? !start.fromDark : start.fromDark;
      if (targetDark !== start.fromDark) {
        setChoice(targetDark ? 'dark' : 'light');
      }
      // Un pointerup après un vrai drag génère un click « fantôme » : on le
      // neutralise pour éviter un double changement.
      suppressedClick.current = true;
      window.setTimeout(() => {
        suppressedClick.current = false;
      }, 0);
    }

    dragStart.current = null;
    setDragOffset(null);
    setDragging(false);
  };

  const handleClick = () => {
    if (suppressedClick.current) {
      suppressedClick.current = false;
      return;
    }
    // Vrai clic / tap / activation clavier sans drag → simple bascule.
    toggle();
  };

  return (
    <div className="inline-flex items-center gap-2.5" data-testid="theme-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label={isDark ? 'Thème sombre' : 'Thème clair'}
        title={isDark ? 'Thème sombre' : 'Thème clair'}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        className={[
          'relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center rounded-full',
          'border outline-none transition-colors duration-200',
          isDark
            ? 'border-neutral-700 bg-neutral-800'
            : 'border-neutral-300 bg-neutral-200',
          'focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-100 dark:focus-visible:ring-offset-neutral-950',
          'select-none touch-none',
          dragging ? 'cursor-grabbing' : 'cursor-pointer',
        ].join(' ')}
        style={{ ['--knob-x' as string]: `${knobPosition}px` }}
      >
        {/* Bouton circulaire mobile (glisse entre les deux positions). */}
        <span
          aria-hidden="true"
          className={[
            'pointer-events-none absolute z-10 flex h-6 w-6 items-center justify-center rounded-full',
            'shadow-md transition-transform duration-200 ease-out',
            isDark ? 'bg-neutral-900 text-amber-300' : 'bg-white text-amber-500',
            dragging ? 'transition-none' : '',
          ].join(' ')}
          style={{ transform: `translateX(var(--knob-x, 0px))` }}
        >
          {isDark ? <MoonIcon className="h-3.5 w-3.5" /> : <SunIcon className="h-3.5 w-3.5" />}
        </span>
      </button>
      {showLabel ? (
        <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200" aria-hidden="true">
          {isDark ? 'Sombre' : 'Clair'}
        </span>
      ) : null}
    </div>
  );
}

export function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

export function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}


