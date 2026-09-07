import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './icons';
import { Button } from './ui';

/**
 * Boîte modale responsive, sans dépendance UI :
 *  - mobile (< md) : bottom sheet pleine largeur, coins supérieurs arrondis ;
 *  - desktop (>= md) : carte centrée.
 * Accessibilité : role="dialog", aria-modal, fermeture Échap, défilement du
 * fond bloqué, titre relié via aria-labelledby.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  labelledBy,
  className,
}: {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Identifiant d'un élément extérieur qui décrit la boîte. */
  labelledBy?: string;
  className?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const root = document.getElementById('root');
  const mount = root ?? document.body;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center md:items-center md:p-4">
      <button
        type="button"
        aria-label="Fermer la fenêtre"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default border-0 bg-black/45 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        className={`card relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[28px] md:max-h-[85vh] md:w-auto md:min-w-[480px] md:max-w-[560px] md:rounded-[26px] ${className ?? ''}`}
      >
        {title || onClose ? (
          <div className="flex items-center justify-between gap-3 border-b px-5 py-4"
            style={{ borderColor: 'var(--edge)' }}
          >
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {onClose ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label="Fermer"
                className="!px-2"
              >
                <IconClose size={18} />
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer ? (
          <div
            className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-4"
            style={{ borderColor: 'var(--edge)' }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    mount,
  );
}
