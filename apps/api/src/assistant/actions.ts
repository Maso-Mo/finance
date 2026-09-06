import type {
  AssistantAction,
  AssistantMissingField,
  AssistantProposalSummary,
  Currency,
} from '@finance/shared-types';
import { ACCOUNT_LABELS, dateValueLabel, moneyFR, resolveCategory, userCurrency } from './refs.js';

/**
 * Couche ACTION (étape 13) :
 *  - détection DÉTERMINISTE des champs réellement manquants d'une intention
 *    (le backend, jamais le modèle, décide ce qui manque) ;
 *  - construction du RÉSUMÉ SÛR de confirmation (le frontend ne reçoit
 *    jamais le payload brut).
 */

// ---------------------------------------------------------------------------
// Détection des champs manquants (déterministe, sans invention)
// ---------------------------------------------------------------------------

export function explainMissing(action: AssistantAction): AssistantMissingField[] {
  switch (action.actionType) {
    case 'TRANSACTION_CREATE':
    case 'TRANSACTION_UPDATE': {
      const t = action.transaction;
      const missing: AssistantMissingField[] = [];
      if (t.type === 'EXPENSE' && !t.categoryRef && !t.categoryUnknown) {
        missing.push('category');
      }
      if (!t.accountType && !t.accountUnknown) missing.push('account');
      if (!t.occurredAt && !t.dateUnknown) missing.push('date');
      return missing;
    }
    case 'TRANSACTION_DELETE':
      return [];
    case 'TRANSFER_CREATE':
    case 'TRANSFER_UPDATE': {
      const t = action.transfer;
      const missing: AssistantMissingField[] = [];
      if (!t.sourceAccountType || !t.destinationAccountType) missing.push('account');
      if (!t.occurredAt && !t.dateUnknown) missing.push('date');
      return missing;
    }
    case 'TRANSFER_DELETE':
      return [];
    case 'PLANNED_EXPENSE_CREATE': {
      const p = action.plannedExpense;
      const missing: AssistantMissingField[] = [];
      if (!p.categoryRef && !p.categoryUnknown) missing.push('category');
      return missing;
    }
    case 'PLANNED_EXPENSE_UPDATE':
      return [];
    case 'PLANNED_EXPENSE_CONFIRM_PAID': {
      const c = action.confirmation;
      const missing: AssistantMissingField[] = [];
      if (!c.accountType && !c.accountUnknown) missing.push('account');
      if (!c.occurredAt && !c.dateUnknown) missing.push('date');
      if (!c.categoryRef && !c.categoryUnknown) missing.push('category');
      return missing;
    }
    case 'PLANNED_EXPENSE_CANCEL':
      return [];
    case 'EXPECTED_INCOME_CREATE':
    case 'EXPECTED_INCOME_UPDATE': {
      const e = action.expectedIncome;
      const missing: AssistantMissingField[] = [];
      if (!e.expectedDate && !(e.windowStart && e.windowEnd)) missing.push('expectedDate');
      return missing;
    }
    case 'EXPECTED_INCOME_CONFIRM_RECEIVED': {
      const c = action.confirmation;
      const missing: AssistantMissingField[] = [];
      if (!c.accountType && !c.accountUnknown) missing.push('account');
      if (!c.occurredAt && !c.dateUnknown) missing.push('date');
      return missing;
    }
    case 'EXPECTED_INCOME_CANCEL':
      return [];
    case 'BUDGET_CREATE':
    case 'BUDGET_UPDATE':
    case 'BUDGET_DELETE':
      return [];
    case 'DEBT_CREATE': {
      const d = action.debt;
      const missing: AssistantMissingField[] = [];
      if (!d.counterpartyName && d.direction === 'I_OWE') missing.push('counterparty');
      const settlement = d.initialSettlement;
      if (settlement && !settlement.accountType && !settlement.accountUnknown) {
        missing.push('account');
      }
      if (settlement && !settlement.occurredAt && !settlement.dateUnknown) {
        missing.push('date');
      }
      return missing;
    }
    case 'DEBT_SETTLEMENT_CREATE': {
      const s = action.settlement;
      const missing: AssistantMissingField[] = [];
      if (!s.accountType && !s.accountUnknown) missing.push('account');
      if (!s.occurredAt && !s.dateUnknown) missing.push('date');
      return missing;
    }
    case 'SAVINGS_PLAN_CREATE':
    case 'SAVINGS_PLAN_UPDATE':
    case 'SAVINGS_PLAN_DELETE':
      return [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Construction des résumés de confirmation (affichage humain uniquement)
// ---------------------------------------------------------------------------

/** Ligne label/valeur d'une carte de confirmation. */
function line(label: string, value: string): { label: string; value: string } {
  return { label, value };
}

function accountLineValue(
  accountType?: string,
  unknown?: boolean,
): string {
  if (unknown === true || !accountType) return 'Compte inconnu';
  return ACCOUNT_LABELS[accountType as keyof typeof ACCOUNT_LABELS] ?? accountType;
}

async function categoryName(categoryRef?: string, unknown?: boolean): Promise<string> {
  if (unknown === true || !categoryRef) return 'Inconnue';
  const resolved = await resolveCategory(categoryRef);
  return resolved ? resolved.name : categoryRef;
}

/**
 * Résumé structuré d'une proposition, généré du payload VALIDÉ.
 * Ce résumé est la SEULE donnée de la proposition exposée au frontend.
 */
export async function buildSummary(
  userId: string,
  action: AssistantAction,
): Promise<AssistantProposalSummary> {
  const currency: Currency | null = await userCurrency(userId);
  const amount = (value: string) => moneyFR(value, currency);
  const date = (day?: string, unknown?: boolean) => dateValueLabel(day, unknown);

  switch (action.actionType) {
    case 'TRANSACTION_CREATE':
    case 'TRANSACTION_UPDATE': {
      const t = action.transaction;
      const isExpense = t.type === 'EXPENSE';
      const isUpdate = action.actionType === 'TRANSACTION_UPDATE';
      const category = await categoryName(t.categoryRef, t.categoryUnknown);
      const lines = [
        line('Type', isExpense ? 'Dépense' : 'Revenu'),
        line('Montant', amount(t.amount)),
        ...(isExpense ? [line('Catégorie', category)] : []),
        line('Compte', accountLineValue(t.accountType, t.accountUnknown)),
        line('Date', date(t.occurredAt, t.dateUnknown)),
        ...(t.description ? [line('Description', t.description)] : []),
      ];
      if (isUpdate) {
        lines.unshift(line('Opération', 'Modification d’une transaction existante'));
      }
      return {
        title: isUpdate
          ? isExpense
            ? 'Modifier la dépense'
            : 'Modifier le revenu'
          : isExpense
            ? 'Dépense à enregistrer'
            : 'Revenu à enregistrer',
        lines,
        confirmLabel: isUpdate ? 'Confirmer la modification' : isExpense ? 'Confirmer la dépense' : 'Confirmer le revenu',
        doneMessage: isExpense ? 'Dépense enregistrée.' : 'Revenu enregistré.',
      };
    }
    case 'TRANSACTION_DELETE':
      return {
        title: 'Supprimer cette opération ?',
        lines: [line('Action', 'Suppression logique de la transaction (elle disparaît du journal et des soldes).')],
        confirmLabel: 'Confirmer la suppression',
        doneMessage: 'Transaction supprimée.',
      };
    case 'TRANSFER_CREATE':
    case 'TRANSFER_UPDATE': {
      const tr = action.transfer;
      const isUpdate = action.actionType === 'TRANSFER_UPDATE';
      const destination = accountLineValue(tr.destinationAccountType, false);
      const source = accountLineValue(tr.sourceAccountType, false);
      const fee = tr.feeAmount ? moneyFR(tr.feeAmount, currency) : null;
      return {
        title: isUpdate ? 'Modifier le transfert' : 'Transfert à enregistrer',
        lines: [
          line('De', source),
          line('Vers', destination),
          line('Montant crédité', amount(tr.amount)),
          ...(fee ? [line('Frais', fee)] : []),
          line('Date', date(tr.occurredAt, tr.dateUnknown)),
          ...(tr.description ? [line('Description', tr.description)] : []),
          ...(tr.savingsPlanId ? [line('Épargne', 'Contribution liée au plan (intention explicite)')] : []),
        ],
        confirmLabel: isUpdate ? 'Confirmer la modification' : 'Confirmer le transfert',
        doneMessage: 'Transfert enregistré.',
      };
    }
    case 'TRANSFER_DELETE':
      return {
        title: 'Supprimer ce transfert ?',
        lines: [line('Action', 'Suppression logique du transfert (plus d’impact sur les soldes).')],
        confirmLabel: 'Confirmer la suppression',
        doneMessage: 'Transfert supprimé.',
      };
    case 'PLANNED_EXPENSE_CREATE': {
      const p = action.plannedExpense;
      const category = await categoryName(p.categoryRef, p.categoryUnknown);
      return {
        title: 'Dépense future à planifier',
        lines: [
          line('Montant prévu', amount(p.amount)),
          line('Échéance', date(p.dueDate)),
          line('Catégorie', category),
          ...(p.description ? [line('Description', p.description)] : []),
          line('Note', 'Aucun solde n’est impacté tant qu’elle n’est pas confirmée payée.'),
        ],
        confirmLabel: 'Planifier cette dépense',
        doneMessage: 'Dépense planifiée.',
      };
    }
    case 'PLANNED_EXPENSE_UPDATE':
      return {
        title: 'Modifier la dépense planifiée',
        lines: [line('Action', 'Mise à jour d’une dépense future (PENDING).')],
        confirmLabel: 'Confirmer la modification',
        doneMessage: 'Dépense planifiée modifiée.',
      };
    case 'PLANNED_EXPENSE_CONFIRM_PAID': {
      const c = action.confirmation;
      const category = await categoryName(c.categoryRef, c.categoryUnknown);
      return {
        title: 'Confirmer le paiement réel',
        lines: [
          line('Montant réel', amount(c.amount)),
          line('Compte', accountLineValue(c.accountType, c.accountUnknown)),
          line('Date', date(c.occurredAt, c.dateUnknown)),
          line('Catégorie', category),
          ...(c.description ? [line('Description', c.description)] : []),
          line('Note', 'Créera une vraie Transaction EXPENSE (workflow « Oui, payé »).'),
        ],
        confirmLabel: 'Confirmer « payé »',
        doneMessage: 'Dépense confirmée comme payée.',
      };
    }
    case 'PLANNED_EXPENSE_CANCEL':
      return {
        title: 'Annuler cette dépense planifiée ?',
        lines: [line('Action', "La dépense future n'aura pas lieu (aucun solde impacté).")],
        confirmLabel: 'Confirmer l’annulation',
        doneMessage: 'Dépense planifiée annulée.',
      };
    case 'EXPECTED_INCOME_CREATE':
    case 'EXPECTED_INCOME_UPDATE': {
      const e = action.expectedIncome;
      const isUpdate = action.actionType === 'EXPECTED_INCOME_UPDATE';
      const window = e.windowStart && e.windowEnd;
      const when = window ? `entre le ${date(e.windowStart)} et le ${date(e.windowEnd)}` : date(e.expectedDate);
      return {
        title: isUpdate ? 'Modifier le revenu attendu' : 'Revenu attendu à enregistrer',
        lines: [
          line('Montant', amount(e.amount)),
          line('Certitude', e.certainty === 'CONFIRMED' ? 'Confirmé' : 'Incertain (non garanti)'),
          line('Période', when),
          ...(e.description ? [line('Description', e.description)] : []),
          line('Note', 'Aucun revenu n’est crédité tant qu’il n’est pas confirmé reçu.'),
        ],
        confirmLabel: isUpdate ? 'Confirmer la modification' : 'Enregistrer ce revenu attendu',
        doneMessage: 'Revenu attendu enregistré.',
      };
    }
    case 'EXPECTED_INCOME_CONFIRM_RECEIVED': {
      const c = action.confirmation;
      return {
        title: 'Confirmer la réception réelle',
        lines: [
          line('Montant réel', amount(c.amount)),
          line('Compte', accountLineValue(c.accountType, c.accountUnknown)),
          line('Date', date(c.occurredAt, c.dateUnknown)),
          ...(c.description ? [line('Description', c.description)] : []),
          line('Note', 'Créera une vraie Transaction INCOME (workflow « Reçu »).'),
        ],
        confirmLabel: 'Confirmer « reçu »',
        doneMessage: 'Revenu confirmé comme reçu.',
      };
    }
    case 'EXPECTED_INCOME_CANCEL':
      return {
        title: 'Annuler ce revenu attendu ?',
        lines: [line('Action', 'Ce revenu ne sera finalement pas attendu (aucun solde impacté).')],
        confirmLabel: 'Confirmer l’annulation',
        doneMessage: 'Revenu attendu annulé.',
      };
    case 'BUDGET_CREATE': {
      const b = action.budget;
      const category = b.categoryRef ? await categoryName(b.categoryRef) : 'Global (toutes dépenses)';
      return {
        title: 'Créer un budget mensuel',
        lines: [
          line('Mois', b.month),
          line('Limite', amount(b.amount)),
          line('Portée', category),
          line('Note', 'Un budget est une limite analytique, jamais de l’argent.'),
        ],
        confirmLabel: 'Créer ce budget',
        doneMessage: 'Budget créé.',
      };
    }
    case 'BUDGET_UPDATE':
      return {
        title: 'Modifier le budget',
        lines: [line('Nouvelle limite', amount(action.amount))],
        confirmLabel: 'Confirmer la modification',
        doneMessage: 'Budget modifié.',
      };
    case 'BUDGET_DELETE':
      return {
        title: 'Supprimer ce budget ?',
        lines: [line('Action', 'Le budget disparaît (aucune écriture financière).')],
        confirmLabel: 'Confirmer la suppression',
        doneMessage: 'Budget supprimé.',
      };
    case 'DEBT_CREATE': {
      const d = action.debt;
      const isAdvance = d.kind === 'INCOME_ADVANCE_RECEIVABLE';
      const direction =
        d.direction === 'I_OWE' ? 'Je dois (dette)' : 'On me doit (créance)';
      const settlement = d.initialSettlement;
      const lines = [
        line('Sens', isAdvance ? 'Avance sur revenu (créance)' : direction),
        line('Montant', amount(d.originalAmount)),
        ...(d.counterpartyName ? [line('Contrepartie', d.counterpartyName)] : []),
        ...(d.description ? [line('Description', d.description)] : []),
        ...(d.dueDate || d.dueDateUnknown ? [line('Échéance', date(d.dueDate ?? undefined, d.dueDateUnknown))] : []),
        line('Note', 'Créer une dette ne bouge AUCUN argent.'),
      ];
      if (settlement) {
        lines.push(
          line('Règlement initial', amount(settlement.amount)),
          line('Compte du règlement', accountLineValue(settlement.accountType, settlement.accountUnknown)),
          line('Date du règlement', date(settlement.occurredAt, settlement.dateUnknown)),
        );
      }
      return {
        title: 'Créer une dette / créance',
        lines,
        confirmLabel: 'Créer',
        doneMessage: isAdvance ? 'Avance enregistrée.' : 'Dette enregistrée.',
      };
    }
    case 'DEBT_SETTLEMENT_CREATE': {
      const s = action.settlement;
      return {
        title: 'Enregistrer un règlement',
        lines: [
          line('Montant', amount(s.amount)),
          line('Compte', accountLineValue(s.accountType, s.accountUnknown)),
          line('Date', date(s.occurredAt, s.dateUnknown)),
          ...(s.description ? [line('Description', s.description)] : []),
          line('Note', 'Réduit le restant de la dette ; solde de compte mis à jour si compte connu.'),
        ],
        confirmLabel: 'Confirmer le règlement',
        doneMessage: 'Règlement enregistré.',
      };
    }
    case 'SAVINGS_PLAN_CREATE':
    case 'SAVINGS_PLAN_UPDATE': {
      const p = action.savingsPlan;
      const isUpdate = action.actionType === 'SAVINGS_PLAN_UPDATE';
      const target = p.mode === 'FIXED' ? amount(p.fixedAmount!) : `${p.percentage} % des revenus du mois`;
      return {
        title: isUpdate ? 'Modifier le plan d’épargne' : 'Créer un plan d’épargne',
        lines: [
          line('Mois', p.month),
          line('Objectif', target),
          line('Note', 'Un plan est un objectif : il ne déplace AUCUN argent.'),
        ],
        confirmLabel: isUpdate ? 'Confirmer la modification' : 'Créer ce plan',
        doneMessage: 'Plan d’épargne enregistré.',
      };
    }
    case 'SAVINGS_PLAN_DELETE':
      return {
        title: 'Supprimer ce plan d’épargne ?',
        lines: [line('Action', 'Le plan disparaît ; les contributions réelles déjà versées restent intactes.')],
        confirmLabel: 'Confirmer la suppression',
        doneMessage: 'Plan d’épargne supprimé.',
      };

    default:
      return {
        title: 'Action à confirmer',
        lines: [line('Action', 'Confirmation requise.')],
        confirmLabel: 'Confirmer',
        doneMessage: 'Action exécutée.',
      };
  }
}

