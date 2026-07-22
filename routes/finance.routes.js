// routes/finance.routes.js
const express = require("express");
const router  = express.Router();
const fc      = require("../controllers/finance.controller");
const { auth, requireManager, requireFinancePin } = require("../middleware/auth.middleware");
const { adminScope }                              = require("../middleware/adminScope");

// ── Middleware global ─────────────────────────────────────────
router.use(auth);
router.use(adminScope);
router.use(requireManager);
router.use(requireFinancePin);

// ── Resumen y reportes ────────────────────────────────────────
router.get("/summary",           fc.getSummary);
router.get("/cashflow",          fc.getCashflow);
router.get("/profit-by-product", fc.getProfitByProduct);
router.get("/provider-debts",    fc.getProviderDebts);
router.get("/provider-analysis", fc.getProviderAnalysis);

// ── Facturas ──────────────────────────────────────────────────
router.get("/invoices",          fc.getInvoices);
router.post("/invoices",         fc.createInvoice);
router.post("/invoices/pay",     fc.payInvoice);

// ── Pago directo a proveedor ──────────────────────────────────
router.post("/provider-payment", fc.payProvider);

// ── Gastos ────────────────────────────────────────────────────
router.get("/expenses",             fc.getExpenses);
router.get("/expenses/by-category", fc.getExpensesByCategory);
router.post("/expenses",            fc.createExpense);

module.exports = router;