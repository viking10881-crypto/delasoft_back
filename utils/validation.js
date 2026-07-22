// ============================================
// 🔍 UTILIDADES DE VALIDACIÓN
// ============================================

/**
 * Validar formato de email
 */
const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email.trim());
};

/**
 * Validar contraseña segura
 * - Mínimo 8 caracteres
 * - Al menos 1 mayúscula
 * - Al menos 1 minúscula
 * - Al menos 1 número
 */
const isStrongPassword = (password) => {
  if (!password || typeof password !== 'string') return false;
  
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password)
  );
};

/**
 * Validar que una cadena no esté vacía
 */
const isNonEmptyString = (str) => {
  return str && typeof str === 'string' && str.trim().length > 0;
};

/**
 * Validar número de cédula (Colombia)
 * Acepta entre 6 y 10 dígitos
 */
const isValidCedula = (cedula) => {
  if (!cedula) return false;
  
  const cleaned = cedula.toString().replace(/\D/g, '');
  return cleaned.length >= 6 && cleaned.length <= 10;
};

/**
 * Validar número de teléfono (Colombia)
 * Acepta formatos: 3001234567, 300-123-4567, (300) 123 4567
 */
const isValidPhone = (phone) => {
  if (!phone) return true; // Teléfono es opcional
  
  const cleaned = phone.toString().replace(/\D/g, '');
  return cleaned.length === 10 && cleaned.startsWith('3');
};

/**
 * Sanitizar entrada de texto
 * Elimina caracteres peligrosos para SQL injection
 */
const sanitizeString = (str) => {
  if (!str || typeof str !== 'string') return '';
  
  return str
    .trim()
    .replace(/[<>]/g, '') // Eliminar < y >
    .replace(/['"]/g, '') // Eliminar comillas
    .substring(0, 255); // Limitar longitud
};

/**
 * Normalizar email
 * Convierte a lowercase y elimina espacios
 */
const normalizeEmail = (email) => {
  if (!email || typeof email !== 'string') return '';
  return email.toLowerCase().trim();
};

/**
 * Validar objeto con campos requeridos
 */
const validateRequiredFields = (obj, requiredFields) => {
  const missing = [];
  
  for (const field of requiredFields) {
    if (!obj[field] || (typeof obj[field] === 'string' && !obj[field].trim())) {
      missing.push(field);
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing
  };
};

/**
 * Validar rango de fecha
 */
const isValidDateRange = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  return !isNaN(start) && !isNaN(end) && start <= end;
};

/**
 * Validar formato de UUID
 */
const isValidUUID = (uuid) => {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
};

/**
 * Validar ID numérico positivo
 */
const isValidId = (id) => {
  const numId = Number(id);
  return Number.isInteger(numId) && numId > 0;
};

/**
 * Generar mensaje de error de validación
 */
const validationError = (field, message) => {
  return {
    success: false,
    message: `Error de validación en ${field}: ${message}`,
    field,
    code: 'VALIDATION_ERROR'
  };
};

/**
 * Validador completo de usuario (registro)
 */
const validateUserRegistration = (data) => {
  const errors = [];

  // Email
  if (!data.email) {
    errors.push('Email es requerido');
  } else if (!isValidEmail(data.email)) {
    errors.push('Formato de email inválido');
  }

  // Contraseña
  if (!data.password) {
    errors.push('Contraseña es requerida');
  } else if (!isStrongPassword(data.password)) {
    errors.push('La contraseña debe tener mínimo 8 caracteres, incluyendo mayúsculas, minúsculas y números');
  }

  // Nombre
  if (!data.name || !isNonEmptyString(data.name)) {
    errors.push('Nombre es requerido');
  } else if (data.name.length > 100) {
    errors.push('Nombre demasiado largo (máximo 100 caracteres)');
  }

  // Cédula
  if (!data.cedula) {
    errors.push('Cédula es requerida');
  } else if (!isValidCedula(data.cedula)) {
    errors.push('Formato de cédula inválido (6-10 dígitos)');
  }

  // Teléfono (opcional)
  if (data.phone && !isValidPhone(data.phone)) {
    errors.push('Formato de teléfono inválido (debe ser un número colombiano de 10 dígitos)');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Validador de actualización de usuario
 */
const validateUserUpdate = (data) => {
  const errors = [];

  // Email (opcional en update, pero debe ser válido si se envía)
  if (data.email && !isValidEmail(data.email)) {
    errors.push('Formato de email inválido');
  }

  // Contraseña (opcional, pero debe ser fuerte si se envía)
  if (data.password && !isStrongPassword(data.password)) {
    errors.push('La contraseña debe tener mínimo 8 caracteres, incluyendo mayúsculas, minúsculas y números');
  }

  // Nombre
  if (data.name !== undefined && !isNonEmptyString(data.name)) {
    errors.push('Nombre no puede estar vacío');
  } else if (data.name && data.name.length > 100) {
    errors.push('Nombre demasiado largo (máximo 100 caracteres)');
  }

  // Cédula
  if (data.cedula && !isValidCedula(data.cedula)) {
    errors.push('Formato de cédula inválido (6-10 dígitos)');
  }

  // Teléfono
  if (data.phone && !isValidPhone(data.phone)) {
    errors.push('Formato de teléfono inválido (debe ser un número colombiano de 10 dígitos)');
  }

  // Role ID
  if (data.role_id !== undefined && !isValidId(data.role_id)) {
    errors.push('ID de rol inválido');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Validador de producto
 */
const validateProduct = (data, isUpdate = false) => {
  const errors = [];

  if (!isUpdate || data.name !== undefined) {
    if (!data.name || !isNonEmptyString(data.name)) {
      errors.push('Nombre del producto es requerido');
    } else if (data.name.length > 200) {
      errors.push('Nombre demasiado largo (máximo 200 caracteres)');
    }
  }

  if (!isUpdate || data.price !== undefined) {
    if (data.price === undefined || data.price === null) {
      errors.push('Precio es requerido');
    } else if (isNaN(data.price) || data.price < 0) {
      errors.push('Precio debe ser un número positivo');
    }
  }

  if (data.stock !== undefined && (isNaN(data.stock) || data.stock < 0)) {
    errors.push('Stock debe ser un número positivo');
  }

  if (data.category_id && !isValidId(data.category_id)) {
    errors.push('ID de categoría inválido');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Validador de paginación
 */
const validatePagination = (page, limit) => {
  const errors = [];

  const numPage = Number(page);
  const numLimit = Number(limit);

  if (isNaN(numPage) || numPage < 1) {
    errors.push('Página debe ser un número mayor a 0');
  }

  if (isNaN(numLimit) || numLimit < 1 || numLimit > 100) {
    errors.push('Límite debe ser un número entre 1 y 100');
  }

  return {
    isValid: errors.length === 0,
    errors,
    page: Math.max(1, numPage),
    limit: Math.min(100, Math.max(1, numLimit))
  };
};

/**
 * Escapar caracteres especiales para búsqueda SQL
 */
const escapeSearchTerm = (term) => {
  if (!term || typeof term !== 'string') return '';
  
  return term
    .replace(/[%_]/g, '\\$&') // Escapar % y _
    .trim();
};

/**
 * Validar y sanitizar input de búsqueda
 */
const sanitizeSearchTerm = (term) => {
  if (!term || typeof term !== 'string') return '';
  
  return term
    .trim()
    .replace(/[<>'"]/g, '')
    .substring(0, 100);
};

module.exports = {
  // Validadores básicos
  isValidEmail,
  isStrongPassword,
  isNonEmptyString,
  isValidCedula,
  isValidPhone,
  isValidId,
  isValidUUID,
  isValidDateRange,
  
  // Sanitizadores
  sanitizeString,
  normalizeEmail,
  escapeSearchTerm,
  sanitizeSearchTerm,
  
  // Validadores compuestos
  validateRequiredFields,
  validateUserRegistration,
  validateUserUpdate,
  validateProduct,
  validatePagination,
  
  // Helpers
  validationError
};