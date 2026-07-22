// src/config/navConfig.js
// Fuente única de verdad para la navegación del panel.
// Cada ítem puede tener:
//   feature   → clave de limits.features que lo habilita
//   roles     → array de roles que pueden ver el ítem (null = todos)
//   limitKey  → recurso de limits.limits para mostrar barra de uso
//   locked    → se muestra con candado cuando feature === false
// ─────────────────────────────────────────────────────────────────

import {
  LayoutDashboard, Package, ShoppingCart, BarChart2,
  History, Users, Shield, Settings, Megaphone,
  Percent, FolderTree, Truck, MessageSquare, Bot,
  Key, Wallet, Phone, Bell, FileText, ChevronRight,
} from "lucide-react";

// ── Items del nav principal ───────────────────────────────────────
export const NAV_ITEMS = [
  // ── Siempre visibles (requieren suscripción activa) ────────────
  {
    id:    "dashboard",
    label: "Dashboard",
    path:  "/",
    icon:  LayoutDashboard,
  },
  {
    id:    "products",
    label: "Productos",
    path:  "/products",
    icon:  Package,
    limitKey: "products",      // muestra barra de uso
  },
  {
    id:    "sales",
    label: "Ventas",
    path:  "/sales",
    icon:  ShoppingCart,
    limitKey: "monthly_sales",
  },
  {
    id:    "history",
    label: "Historial",
    path:  "/history",
    icon:  History,
  },

  // ── Analytics — requiere feature ──────────────────────────────
  {
    id:      "analytics",
    label:   "Analytics",
    path:    "/analytics",
    icon:    BarChart2,
    feature: "analytics",
    locked:  true,
  },

  // ── Usuarios ──────────────────────────────────────────────────
  {
    id:       "users",
    label:    "Usuarios",
    path:     "/users",
    icon:     Users,
    limitKey: "users",
    roles:    ["superadmin", "admin", "manager"],
  },

  // ── Admins — solo superadmin ve a todos; admin ve esta opción solo si multi_admin ─
  {
    id:      "admins",
    label:   "Administradores",
    path:    "/admins",
    icon:    Shield,
    feature: "multi_admin",
    locked:  true,
    roles:   ["superadmin", "admin"],
  },

  // ── Herramientas ─────────────────────────────────────────────
  {
    id:    "tools",
    label: "Herramientas",
    icon:  Settings,
    children: [
      {
        id:    "agent",
        label: "Agente IA",
        path:  "/tools/agent",
        icon:  Bot,
        feature: "ai_agent",
        locked:  true,
      },
      {
        id:    "finance",
        label: "Finanzas",
        path:  "/tools/finance",
        icon:  Wallet,
        feature: "financial_reports",
        locked:  true,
      },
      {
        id:    "providers",
        label: "Proveedores",
        path:  "/tools/providers",
        icon:  Truck,
        feature: "purchase_orders",
        locked:  true,
        limitKey: "providers",
      },
      {
        id:    "categories",
        label: "Categorías",
        path:  "/tools/categories",
        icon:  FolderTree,
        limitKey: "categories",
      },
      {
        id:    "discounts",
        label: "Descuentos",
        path:  "/tools/discounts",
        icon:  Percent,
        feature: "discount_system",
        locked:  true,
      },
      {
        id:       "banners",
        label:    "Banners",
        path:     "/tools/banners",
        icon:     Megaphone,
        roles:    ["superadmin", "admin"],
        limitKey: "banners",
      },
      {
        id:    "api-keys",
        label: "API Keys",
        path:  "/tools/api-keys",
        icon:  Key,
        feature: "api_access",
        locked:  true,
        limitKey: "api_keys",
        roles:   ["superadmin", "admin"],
      },
      {
        id:    "inventory",
        label: "Inventario",
        path:  "/tools/inventory",
        icon:  Package,       // o el ícono que uses para inventario
        feature: "inventory",
        locked:  true,
      },
      {
        id:    "business-profile",
        label: "Mi Negocio",
        path:  "/tools/business-profile",
        icon:  FileText,
        feature: "custom_branding",
        locked:  true,
        roles:   ["superadmin", "admin"],
      },
      {
        id:    "contact",
        label: "Mensajes",
        path:  "/tools/contact-messages",
        icon:  MessageSquare,
        roles: ["superadmin", "admin"],
      },
      {
        id:    "chat",
        label: "Chat",
        path:  "/tools/chat",
        icon:  Phone,
      },
    ],
  },

  // ── Suscripción — siempre visible ─────────────────────────────
  {
    id:    "subscription",
    label: "Mi Suscripción",
    path:  "/subscription",
    icon:  Bell,
  },

  // ── Setup — solo superadmin ───────────────────────────────────
  {
    id:    "setup",
    label: "Setup",
    path:  "/setup",
    icon:  Settings,
    roles: ["superadmin"],
  },
];

// ─────────────────────────────────────────────────────────────────
// Helper: filtra el nav según rol + features de suscripción
// Retorna los ítems con un campo `isLocked` si no tienen acceso
// pero deben mostrarse con candado (locked: true en la config).
// ─────────────────────────────────────────────────────────────────
export function buildVisibleNav(userRoles = [], canUse = () => true) {
  const isSuperAdmin = userRoles.includes("superadmin");

  function processItem(item) {
    // Filtrar por roles
    if (item.roles && !isSuperAdmin) {
      const hasRole = item.roles.some(r => userRoles.includes(r));
      if (!hasRole) return null;
    }

    // Feature gate
    const featureEnabled = item.feature ? canUse(item.feature) : true;
    const isLocked = item.locked && !featureEnabled && !isSuperAdmin;

    // Procesar children recursivamente
    if (item.children) {
      const children = item.children
        .map(processItem)
        .filter(Boolean);

      // Si todos los hijos están completamente ocultos (no solo locked), ocultar padre
      if (children.length === 0) return null;

      return { ...item, children, isLocked: false };
    }

    return { ...item, isLocked, featureEnabled };
  }

  return NAV_ITEMS.map(processItem).filter(Boolean);
}