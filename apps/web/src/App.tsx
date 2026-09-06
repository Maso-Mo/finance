import { Route, Routes, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import HomePage from './pages/HomePage';
import TransactionsPage from './pages/TransactionsPage';
import PlannedExpensesPage from './pages/PlannedExpensesPage';
import ExpectedIncomesPage from './pages/ExpectedIncomesPage';
import BudgetsPage from './pages/BudgetsPage';

/**
 * Routage minimal : login / register / pages protégées (accueil, transactions,
 * dépenses à venir, revenus à venir).
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/" element={<HomePage />} />
      <Route path="/transactions" element={<TransactionsPage />} />
      <Route path="/planned" element={<PlannedExpensesPage />} />
      <Route path="/expected" element={<ExpectedIncomesPage />} />
      <Route path="/budgets" element={<BudgetsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
