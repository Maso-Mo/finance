import { lazy, Suspense } from 'react';
import { Route, Routes, Navigate } from 'react-router-dom';
import Chrome from './components/chrome';

const AccountingPage = lazy(() => import('./pages/AccountingPage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'));
const PlannedExpensesPage = lazy(() => import('./pages/PlannedExpensesPage'));
const ExpectedIncomesPage = lazy(() => import('./pages/ExpectedIncomesPage'));
const BudgetsPage = lazy(() => import('./pages/BudgetsPage'));
const TransfersPage = lazy(() => import('./pages/TransfersPage'));
const SavingsPage = lazy(() => import('./pages/SavingsPage'));
const DebtsPage = lazy(() => import('./pages/DebtsPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const AssistantPage = lazy(() => import('./pages/AssistantPage'));

/**
 * Code splitting par route : chaque page est un chunk Vite chargé à la demande.
 * Les pages authentifiées vivent dans <Chrome/> (sidebar desktop + barre
 * mobile + cloche/actions globales). Login/Register restent autonomes.
 * Le shell initial reste minimal ; les pages lourdes ne sont téléchargées
 * qu'à la navigation.
 */
export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-ink2">
          Chargement…
        </div>
      }
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        <Route element={<Chrome />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/accounting" element={<AccountingPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/planned" element={<PlannedExpensesPage />} />
          <Route path="/expected" element={<ExpectedIncomesPage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/transfers" element={<TransfersPage />} />
          <Route path="/savings" element={<SavingsPage />} />
          <Route path="/debts" element={<DebtsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

