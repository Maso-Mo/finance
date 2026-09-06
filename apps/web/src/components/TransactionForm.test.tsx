import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TransactionForm from './TransactionForm';
import type { AccountPublic, CategoryPublic } from '@finance/shared-types';

const accounts: AccountPublic[] = [
  {
    id: 'a-bank',
    type: 'BANK',
    currency: 'MGA',
    initialBalance: '100000.00',
    balance: '100000.00',
  },
  {
    id: 'a-cash',
    type: 'CASH',
    currency: 'MGA',
    initialBalance: '0.00',
    balance: '0.00',
  },
];

const categories: CategoryPublic[] = [
  { id: 'c-food', code: 'food', name: 'Nourriture', isSystem: true },
];

function renderForm() {
  return render(
    <TransactionForm
      accounts={accounts}
      categories={categories}
      currency="MGA"
      editing={null}
      isSubmitting={false}
      submitError={null}
      onCancel={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
}

describe('TransactionForm — activation d’une allocation de compte', () => {
  it('cocher « Ajouter Banque » après le montant pré-remplit le reste non alloué', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByPlaceholderText('0'), '12000');
    await user.click(screen.getByLabelText('Ajouter Banque'));

    const bankAmount = screen.getByLabelText('Ajouter Banque').closest('div');
    expect(bankAmount).not.toBeNull();
    const bankInputs = bankAmount!.querySelectorAll('input[placeholder="Montant…"]');
    expect(bankInputs.length).toBe(1);
    expect(bankInputs[0]).toHaveValue('12000.00');
    expect((bankInputs[0] as HTMLInputElement).disabled).toBe(false);
  });

  it('réduire la part Banque puis cocher Cash pré-remplit le solde restant', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByPlaceholderText('0'), '12000');
    await user.click(screen.getByLabelText('Ajouter Banque'));
    const bankInput = screen
      .getByLabelText('Ajouter Banque')
      .closest('div')!
      .querySelector('input[placeholder="Montant…"]') as HTMLInputElement;
    await bankInput.focus();
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('6000');

    await user.click(screen.getByLabelText('Ajouter Cash'));
    const cashInput = screen
      .getByLabelText('Ajouter Cash')
      .closest('div')!
      .querySelector('input[placeholder="Montant…"]') as HTMLInputElement;
    expect(cashInput).toHaveValue('6000.00');
    expect(cashInput.disabled).toBe(false);
  });

  it('décocher un compte vide sa répartition', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByPlaceholderText('0'), '12000');
    await user.click(screen.getByLabelText('Ajouter Banque'));
    await user.click(screen.getByLabelText('Ajouter Banque'));

    const bankInput = screen
      .getByLabelText('Ajouter Banque')
      .closest('div')!
      .querySelector('input[placeholder="Montant…"]') as HTMLInputElement | null;
    // Une fois désinclus, le champ redevient désactivé et vide (placeholder vide).
    expect(bankInput).toBeNull();
  });
});
