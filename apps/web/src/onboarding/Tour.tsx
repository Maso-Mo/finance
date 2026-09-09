import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useOnboarding } from './OnboardingProvider';
import { ONBOARDING_STEPS, ONBOARDING_TOTAL } from './steps';
import { Button } from '../components/ui';
import { IconArrowRight, IconCheck, IconClose, IconInfo } from '../components/icons';

/**
 * Visite guidée « prise en main » — 14 étapes en surbrillance.
 * - Grand écran : anneau autour de l'élément ciblé + carte flottante.
 * - Mobile : carte bas de page + anneau quand l'élément est trouvable.
 * - Rien n'est persisté avant « J'ai compris » + confirmation « Terminer ».
 * - Accessibilité : role="dialog", aria-modal, Échap, contraste AA,
 *   focus ramené dans la carte à chaque étape.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isDesktopViewport(): boolean {
  try {
    return window.matchMedia('(min-width: 1024px)').matches;
  } catch {
    return false;
  }
}

/** Premier élément visible correspondant au sélecteur (taille réelle). */
function pickVisible(selector: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function computeCardStyle(
  rect: Rect | null,
  viewport: { width: number; height: number },
  desktop: boolean,
  cardHeight: number,
): CSSProperties | null {
  if (!desktop) return null;
  const cardWidth = 408;
  const gap = 24;
  const margin = 16;

  let left: number;
  if (rect && rect.x + rect.width + gap + cardWidth <= viewport.width - margin) {
    left = rect.x + rect.width + gap;
  } else if (rect && rect.x - gap - cardWidth >= margin) {
    left = rect.x - gap - cardWidth;
  } else if (rect) {
    left = clamp(rect.x, margin, viewport.width - cardWidth - margin);
  } else {
    left = margin;
  }

  let top: number;
  if (rect && rect.y + rect.height + gap + cardHeight <= viewport.height - margin) {
    top = rect.y + rect.height + gap;
  } else if (rect && rect.y - gap - cardHeight >= margin) {
    top = rect.y - gap - cardHeight;
  } else if (rect) {
    top = clamp(rect.y + rect.height - cardHeight - 64, margin, viewport.height - cardHeight - margin);
  } else {
    top = viewport.height - cardHeight - margin;
  }
  return { left: Math.round(left), top: Math.round(top), width: cardWidth };
}

/* ==================== Composant public ==================== */

export function OnboardingTour() {
  const { open } = useOnboarding();
  if (!open) return null;
  return <TourDialog />;
}
function TourDialog() {
  const { close, complete } = useOnboarding();
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [desktop, setDesktop] = useState(isDesktopViewport);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [cardHeight, setCardHeight] = useState(400);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const step = ONBOARDING_STEPS[stepIndex];
  if (!step) {
    return null; // filet de sécurité
  }

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!cardRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setCardHeight(cardRef.current?.getBoundingClientRect().height ?? 400));
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  // Verrouille le défilement de la page pendant le guide.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Défilement doux + mesure continue de la cible à chaque étape.
  useEffect(() => {
    const targetSelector = ONBOARDING_STEPS[stepIndex]?.target;
    if (!targetSelector) {
      setRect(null);
      return;
    }
    window.dispatchEvent(new CustomEvent('finance-guide-target', { detail: targetSelector }));
    const el = pickVisible(targetSelector);
    if (!el) setRect(null);
    try {
      el?.scrollIntoView({
        block: 'center',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    } catch {
      // environnement sans défilement (tests) : on continue.
    }

    let alive = true;
    let frame = 0;
    const update = () => {
      if (!alive) return;
      const target = pickVisible(targetSelector);
      if (!target) return;
      const r = target.getBoundingClientRect();
      setRect({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    const hasRaf =
      typeof window.requestAnimationFrame === 'function' &&
      typeof window.cancelAnimationFrame === 'function';
    if (hasRaf) {
      const tick = () => {
        if (!alive) return;
        update();
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    } else {
      // environnement de test sans animation frames : une mesure suffit.
      update();
    }
    return () => {
      alive = false;
      if (hasRaf) window.cancelAnimationFrame(frame);
    };
  }, [stepIndex]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      window.dispatchEvent(new CustomEvent('finance-guide-target', { detail: null }));
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const panel = confirmOpen ? confirmRef.current : cardRef.current;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return;
      const buttons = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]'));
      const first = buttons[0], last = buttons.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement as HTMLElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [confirmOpen]);

  // Échap : ferme la confirmation d'abord, sinon le guide (sans persister).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (confirmOpen) {
        setConfirmOpen(false);
      } else {
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirmOpen, close]);

  // Focus la carte au changement d'étape, puis le bouton de la confirmation.
  useEffect(() => {
    if (confirmOpen) {
      document.getElementById('tour-confirm-finish')?.focus();
    } else {
      titleRef.current?.focus();
    }
  }, [stepIndex, confirmOpen]);

  function goPrevious() {
    setStepIndex((index) => Math.max(0, index - 1));
  }

  function goNext() {
    const isLast = stepIndex >= ONBOARDING_TOTAL - 1;
    if (isLast) {
      setFinishError(null);
      setConfirmOpen(true);
      return;
    }
    setStepIndex((index) => Math.min(ONBOARDING_TOTAL - 1, index + 1));
  }

  async function handleFinish() {
    setBusy(true);
    setFinishError(null);
    try {
      await complete();
      setConfirmOpen(false);
    } catch {
      setFinishError(
        'La sauvegarde a échoué. Vérifiez votre connexion puis réessayez : vos données financières ne sont pas affectées.',
      );
    } finally {
      setBusy(false);
    }
  }

  const isLast = stepIndex >= ONBOARDING_TOTAL - 1;
  const isFirst = stepIndex === 0;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const cardStyle = computeCardStyle(rect, viewport, desktop, cardHeight);
  const scrim = 'rgba(7, 11, 14, 0.58)';
  const total = ONBOARDING_TOTAL;
  const progress = ((stepIndex + 1) / total) * 100;
  const hasTargetRing = rect !== null;

  const tourCard = (
    <section
      ref={cardRef}
      inert={confirmOpen}
      role="dialog"
      aria-describedby="tour-description"
      aria-modal="true"
      aria-labelledby="tour-title"
      className={
        desktop
          ? 'card fixed z-[1020] flex max-h-[calc(100dvh_-_32px)] w-[408px] flex-col overflow-hidden'
          : 'card fixed inset-x-4 bottom-[max(16px,env(safe-area-inset-bottom))] z-[1020] flex max-h-[calc(100dvh_-_32px)] flex-col overflow-hidden sm:mx-auto sm:max-w-[520px]'
      }
      style={{ ...(desktop && cardStyle ? cardStyle : {}), background: 'var(--surface)', color: 'var(--text)', pointerEvents: 'auto' }}
    >
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <span
          className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: 'var(--brand-soft)', color: 'var(--brand-strong)' }}
        >
          Étape {stepIndex + 1} / {total}
        </span>
        <Button variant="ghost" size="sm" aria-label="Quitter le guide sans rien enregistrer" className="!px-2" onClick={close}>
          <IconClose size={17} />
        </Button>
      </div>
      <div className="h-1.5 w-full bg-surface-2">
        <div className="h-1.5 rounded-full transition-all duration-200" style={{ width: `${progress}%`, background: 'var(--brand)' }} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <span
          aria-hidden="true"
          className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-2xl"
          style={{ background: isLast ? 'var(--brand)' : 'var(--surface-2)' }}
        >
          {isLast ? (
            <IconCheck size={20} className="text-[var(--brand-ink)]" />
          ) : (
            <span className="num text-base font-bold text-ink">{stepIndex + 1}</span>
          )}
        </span>
        <h2 id="tour-title" ref={titleRef} tabIndex={-1} className="text-lg font-bold tracking-tight text-ink outline-none">
          {step.title}
        </h2>
        <p id="tour-description" style={{ color: 'var(--text-muted)' }} className="mt-1.5 text-sm leading-relaxed">{step.body}</p>
        {isLast && <p className="mt-4 text-sm font-semibold text-ink">Tu connais maintenant l’essentiel de Finance.</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-4" style={{ borderColor: 'var(--edge)' }}>
        <Button variant="ghost" size="sm" disabled={isFirst} onClick={goPrevious}>
          Précédent
        </Button>
        <Button variant="primary" size="sm" onClick={goNext}>
          {isLast ? "J'ai compris, terminer le guide" : 'Suivant'}
          {!isLast ? <IconArrowRight size={14} /> : null}
        </Button>
      </div>
      <p className="px-5 pb-4 text-[11px] leading-relaxed text-ink3">
        {isLast
          ? 'Votre progression n’est enregistrée qu’après confirmation. Quitter maintenant ne change rien.'
          : 'Vous pourrez retrouver ce guide à tout moment depuis le menu « Plus ».'}
      </p>
    </section>
  );

  return createPortal(
    <div className="fixed inset-0 z-[1000]">
      {hasTargetRing && rect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[1010] rounded-[18px]"
          style={{
            left: rect.x - 10,
            top: rect.y - 10,
            width: rect.width + 20,
            height: rect.height + 20,
            border: '2px solid var(--brand)',
            boxShadow: `0 0 0 9999px ${scrim}`,
          }}
        />
      ) : (
        <div aria-hidden="true" className="fixed inset-0" style={{ background: scrim }} />
      )}
      {tourCard}
      {confirmOpen ? (
        <div className="fixed inset-0 z-[1030] flex items-end justify-center p-4 md:items-center">
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{ background: 'rgba(7, 11, 14, 0.68)' }}
            onClick={() => {
              if (!busy) setConfirmOpen(false);
            }}
          />
          <div
            ref={confirmRef}
            aria-describedby="tour-confirm-description"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tour-confirm-title"
            className="card relative z-10 w-full max-w-md overflow-hidden"
          >
            <div className="border-b px-5 py-4" style={{ borderColor: 'var(--edge)' }}>
              <h2 id="tour-confirm-title" className="text-base font-semibold tracking-tight text-ink">
                Terminer le guide ?
              </h2>
            </div>
            <div className="px-5 py-4">
              <p id="tour-confirm-description" className="text-sm leading-relaxed text-ink2">
                Il ne s’affichera plus automatiquement, mais tu pourras le revoir quand tu veux.
              </p>
              {finishError ? (
                <p
                  role="alert"
                  className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[13px]"
                  style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}
                >
                  <IconInfo size={15} className="mt-0.5 shrink-0" />
                  {finishError}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmOpen(false)}>
                  Annuler
                </Button>
                <Button variant="primary" size="sm" id="tour-confirm-finish" disabled={busy} onClick={() => void handleFinish()}>
                  {busy ? 'Enregistrement…' : 'Terminer'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}




