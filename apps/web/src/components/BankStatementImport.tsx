import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  Currency,
  StatementIgnoredLine,
  StatementPreviewResponse,
  StatementProviderHint,
} from '@finance/shared-types';
import {
  apiExtractStatementPdf,
  apiImportStatement,
  apiPreviewStatement,
} from '../auth/api';
import { formatMoney } from '../lib/format';
import { Button } from './ui';
import { Dialog } from './overlay';

/**
 * Import d'un relevé bancaire / mobile money (PDF ou texte) — Comptabilité.
 *
 * Chaîne de confiance : fichier → extraction locale → APERÇU STRICTEMENT
 * read-only → revue humaine ligne par ligne → import des SEULES lignes
 * confirmées (le serveur re-parse le texte : aucun montant/type arbitraire).
 * Les lignes déjà importées sont signalées et exclues par défaut ; les lignes
 * ambiguës sont listées (ignorées), JAMAIS devinées. Hors-ligne → message
 * clair, aucune écriture.
 */

const PROVIDER_LABELS: Record<StatementProviderHint, string> = {
  BANK: 'Banque',
  MVOLA: 'MVola',
  ORANGE_MONEY: 'Orange Money',
  AIRTEL_MONEY: 'Airtel Money',
};

const KIND_LABELS: Record<'INCOME' | 'EXPENSE', string> = {
  INCOME: 'Revenu',
  EXPENSE: 'Dépense',
};

export default function BankStatementImport({ currency }: { currency: Currency }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [fileName, setFileName] = useState('');
  const [provider, setProvider] = useState<StatementProviderHint>('BANK');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<StatementPreviewResponse | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const reset = () => {
    setOpen(false);
    setBusy(false);
    setError('');
    setSuccess('');
    setFileName('');
    setPreview(null);
    setSelected(new Set());
    setText('');
  };

  const analyse = async (source: string, hint: StatementProviderHint) => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await apiPreviewStatement({ provider: hint, text: source });
      setPreview(result);
      setSelected(
        new Set(
          result.rows
            .filter((row) => !row.alreadyImported)
            .map((row) => row.line),
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'Failed to fetch'
          ? 'Cette action nécessite une connexion à Finance.'
          : err instanceof Error
            ? err.message
            : 'Aperçu impossible.',
      );
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (file: File) => {
    setFileName(file.name);
    setError('');
    setSuccess('');
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.txt')) {
        const content = await file.text();
        setText(content);
        void analyse(content, provider);
      } else if (lower.endsWith('.pdf')) {
        const pdf = await file.arrayBuffer();
        const extracted = await apiExtractStatementPdf(pdf);
        setText(extracted.text);
        void analyse(extracted.text, provider);
      } else {
        setError('Formats acceptés : PDF (.pdf) ou texte (.txt).');
      }
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'Failed to fetch'
          ? 'Cette action nécessite une connexion à Finance.'
          : err instanceof Error
            ? err.message
            : 'Lecture du fichier impossible.',
      );
    }
  };

  const toggle = (line: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });
  };

  const chooseAnotherFile = () => {
    if (busy) return;
    setPreview(null);
    setSelected(new Set());
    setSuccess('');
    setError('');
    setText('');
  };
  const confirmImport = async () => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await apiImportStatement({
        provider,
        text,
        rowIndices: [...selected].sort((a, b) => a - b),
      });
      setSuccess(
        `${result.imported.length} ligne${result.imported.length > 1 ? 's' : ''} importée${
          result.imported.length > 1 ? 's' : ''
        }${result.skippedDuplicates > 0 ? ` · ${result.skippedDuplicates} doublon(s) ignoré(s)` : ''}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['accounting'] });
      await queryClient.invalidateQueries({ queryKey: ['accounting-journal'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void analyse(text, provider);
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'Failed to fetch'
          ? 'Cette action nécessite une connexion à Finance.'
          : err instanceof Error
            ? err.message
            : 'Import impossible.',
      );
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];
  const ignored = preview?.ignored ?? ([] as StatementIgnoredLine[]);
  const newRows = rows.filter((row) => !row.alreadyImported);
  const anyNewRow = newRows.length > 0;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Importer un relevé bancaire
      </Button>

      <Dialog
        open={open}
        onClose={busy ? undefined : reset}
        title="Importer un relevé bancaire"
        footer={
          <>
            <Button variant="secondary" onClick={reset} disabled={busy}>
              {preview ? 'Annuler tout' : 'Fermer'}
            </Button>
            {preview && (
              <Button
                onClick={confirmImport}
                disabled={!anyNewRow || selected.size === 0 || busy}
              >
                {busy
                  ? 'Confirmation…'
                  : `Importer ${selected.size} ligne${selected.size > 1 ? 's' : ''}`}
              </Button>
            )}
          </>
        }
      >
        {!preview ? (
          <div className="space-y-4">
            <p className="text-sm text-ink2">
              Choisis un relevé (PDF ou texte). L’extraction et l’aperçu sont
              100&nbsp;% locaux : rien n’est écrit avant ta confirmation, et
              aucune ligne ambiguë n’est jamais devinée.
            </p>
            <label className="block">
              <span className="text-sm font-medium">Type de relevé</span>
              <select
                aria-label="Type de relevé"
                className="field mt-1 w-full"
                value={provider}
                onChange={(event) =>
                  setProvider(event.target.value as StatementProviderHint)
                }
                disabled={busy}
              >
                {(Object.keys(PROVIDER_LABELS) as StatementProviderHint[]).map(
                  (key) => (
                    <option key={key} value={key}>
                      {PROVIDER_LABELS[key]}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-sm">
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.txt,application/pdf,text/plain"
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void pickFile(file);
                  event.target.value = '';
                }}
              />
              {busy ? 'Analyse en cours…' : 'Choisir un fichier (PDF ou .txt)'}
            </label>
            {fileName && busy && (
              <p className="text-xs text-ink2">
                {fileName} — extraction en cours…
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="break-words text-sm text-ink2">
                {fileName} · {rows.length} ligne{rows.length > 1 ? 's' : ''} reconnue
                {rows.length > 1 ? 's' : ''}
                {rows.length === 0
                  ? ' — aucune écriture possible.'
                  : ' — coche/décoche pour choisir.'}
              </p>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={chooseAnotherFile}
              >
                Choisir un autre fichier
              </Button>
            </div>
            {rows.length === 0 && ignored.length > 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Aucune ligne n’a été reconnue dans ce fichier. Les lignes
                ambiguës sont listées ci-dessous et ne seront jamais importées
                automatiquement.
              </p>
            )}
            {rows.length > 0 && (
              <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {rows.map((row) => {
                  const checked = selected.has(row.line);
                  return (
                    <li
                      key={row.line}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        row.alreadyImported
                          ? 'border-neutral-200 bg-neutral-50 opacity-70 dark:border-neutral-800 dark:bg-neutral-900'
                          : 'border-neutral-200 dark:border-neutral-800'
                      }`}
                    >
                      <label
                        className={`flex items-start gap-2 ${
                          row.alreadyImported
                            ? 'cursor-not-allowed'
                            : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          disabled={busy || row.alreadyImported}
                          checked={checked}
                          aria-label={`Importer la ligne ${row.line}`}
                          onChange={() => toggle(row.line)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline justify-between gap-2">
                            <strong className="text-xs font-semibold text-ink">
                              {row.date ?? 'date inconnue'} · {KIND_LABELS[row.kind]}
                            </strong>
                            <span className="num text-xs font-medium">
                              {row.kind === 'EXPENSE' ? '−' : '+'}
                              {formatMoney(row.amount, currency)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-ink2">
                            {row.description ?? 'Sans libellé'}
                          </span>
                          {row.alreadyImported && (
                            <span className="mt-1 block text-xs text-ink2">
                              Déjà importée — ignorée (aucun doublon créé).
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {ignored.length > 0 && (
              <details className="text-xs text-ink2">
                <summary className="cursor-pointer">
                  Lignes ignorées ({ignored.length}) — non importables
                </summary>
                <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto pl-1">
                  {ignored.map((line) => (
                    <li key={line.line} className="flex flex-col">
                      <span>
                        Ligne {line.line} — {line.reason}
                      </span>
                      <code className="truncate text-[11px] opacity-70">
                        {line.raw}
                      </code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {success && (
              <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                {success}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {error}
              </p>
            )}
            {!anyNewRow && rows.length > 0 && (
              <p className="text-xs text-ink2">
                Toutes les lignes de ce fichier ont déjà été importées : rien de
                nouveau à écrire.
              </p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

