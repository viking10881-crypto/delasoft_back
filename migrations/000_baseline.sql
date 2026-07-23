--
-- PostgreSQL database dump
--

\restrict yIcdaXMCsKVZNDVbunpYmHgZeAngJUVk9fcSvZqmZkO0lLTJPAp9jLpmaN6bvER

-- Dumped from database version 17.10 (21f7c76)
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: billing_cycle_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.billing_cycle_type AS ENUM (
    'monthly',
    'yearly',
    'one_time'
);


--
-- Name: delivery_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_status_type AS ENUM (
    'pending',
    'ready_to_deliver',
    'partial_delivered',
    'delivered',
    'cancelled'
);


--
-- Name: expense_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.expense_type AS ENUM (
    'purchase',
    'service',
    'utility',
    'tax',
    'salary',
    'other',
    'inventory_initial',
    'cogs_direct'
);


--
-- Name: fulfillment_mode_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.fulfillment_mode_type AS ENUM (
    'stock',
    'on_demand',
    'hybrid'
);


--
-- Name: gateway_transaction_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.gateway_transaction_status AS ENUM (
    'pending',
    'approved',
    'declined',
    'voided',
    'error',
    'refunded'
);


--
-- Name: notification_channel_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel_type AS ENUM (
    'whatsapp',
    'email',
    'push',
    'sms'
);


--
-- Name: notification_event_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_event_type AS ENUM (
    'new_sale',
    'new_on_demand_sale',
    'procurement_needed',
    'procurement_overdue',
    'sale_paid',
    'sale_delivered',
    'low_stock',
    'payment_received',
    'credit_reminder_upcoming',
    'credit_reminder_due',
    'credit_reminder_overdue'
);


--
-- Name: notification_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_status_type AS ENUM (
    'pending',
    'sending',
    'sent',
    'failed',
    'cancelled'
);


--
-- Name: order_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status_type AS ENUM (
    'draft',
    'pending',
    'received',
    'cancelled'
);


--
-- Name: payment_account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_account_status AS ENUM (
    'pending',
    'connected',
    'disabled'
);


--
-- Name: payment_environment; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_environment AS ENUM (
    'sandbox',
    'production'
);


--
-- Name: payment_method_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_method_type AS ENUM (
    'cash',
    'credit',
    'transfer',
    'check',
    'gateway'
);


--
-- Name: payment_provider_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_provider_type AS ENUM (
    'wompi',
    'mercadopago',
    'payu'
);


--
-- Name: payment_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status_type AS ENUM (
    'paid',
    'pending',
    'partial'
);


--
-- Name: procurement_order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.procurement_order_status AS ENUM (
    'pending',
    'ordered_to_supplier',
    'received',
    'cancelled'
);


--
-- Name: procurement_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.procurement_status_type AS ENUM (
    'not_required',
    'pending',
    'partial',
    'complete'
);


--
-- Name: provider_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_category AS ENUM (
    'Materia Prima',
    'Servicios',
    'Productos Terminados'
);


--
-- Name: stock_movement_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.stock_movement_type AS ENUM (
    'purchase_received',
    'return',
    'manual_adjustment',
    'reservation_created',
    'reservation_released',
    'reservation_confirmed',
    'sale_confirmed',
    'sale_cancelled',
    'damage_loss',
    'transfer_in',
    'transfer_out',
    'initial_stock'
);


--
-- Name: stock_reservation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.stock_reservation_status AS ENUM (
    'active',
    'confirmed',
    'expired',
    'cancelled'
);


--
-- Name: subscription_status_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_status_type AS ENUM (
    'trial',
    'active',
    'past_due',
    'suspended',
    'cancelled',
    'expired'
);


--
-- Name: calculate_purchase_order_totals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_purchase_order_totals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE purchase_orders SET
        subtotal = (
            SELECT COALESCE(SUM(subtotal), 0)
            FROM purchase_order_items
            WHERE purchase_order_id = NEW.purchase_order_id
        ),
        total_cost = (
            SELECT COALESCE(SUM(subtotal), 0) + COALESCE(NEW.tax_amount, 0) + 
                   COALESCE(NEW.shipping_cost, 0) - COALESCE(NEW.discount_amount, 0)
            FROM purchase_order_items
            WHERE purchase_order_id = NEW.purchase_order_id
        )
    WHERE id = NEW.purchase_order_id;
    
    RETURN NEW;
END;
$$;


--
-- Name: fn_record_stock_movement(integer, integer, public.stock_movement_type, integer, character varying, integer, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_record_stock_movement(p_product_id integer, p_variant_id integer, p_movement_type public.stock_movement_type, p_qty_delta integer, p_reference_type character varying, p_reference_id integer, p_notes text, p_created_by integer, p_owner_admin_id integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_qty_before integer;
  v_qty_after  integer;
  v_ledger_id  integer;
BEGIN
  IF p_variant_id IS NOT NULL THEN
    SELECT stock INTO v_qty_before FROM product_variants WHERE id = p_variant_id FOR UPDATE;
    IF v_qty_before IS NULL THEN
      RAISE EXCEPTION 'Variant % not found', p_variant_id;
    END IF;
    v_qty_after := v_qty_before + p_qty_delta;
    IF v_qty_after < 0 THEN
      RAISE EXCEPTION 'Stock negativo no permitido (variant=%, before=%, delta=%)',
        p_variant_id, v_qty_before, p_qty_delta;
    END IF;
    UPDATE product_variants SET stock = v_qty_after, updated_at = now() WHERE id = p_variant_id;
  ELSE
    SELECT stock INTO v_qty_before FROM products WHERE id = p_product_id FOR UPDATE;
    IF v_qty_before IS NULL THEN
      RAISE EXCEPTION 'Product % not found', p_product_id;
    END IF;
    v_qty_after := v_qty_before + p_qty_delta;
    IF v_qty_after < 0 THEN
      RAISE EXCEPTION 'Stock negativo no permitido (product=%, before=%, delta=%)',
        p_product_id, v_qty_before, p_qty_delta;
    END IF;
    UPDATE products SET stock = v_qty_after, updated_at = now() WHERE id = p_product_id;
  END IF;

  INSERT INTO stock_ledger (
    product_id, variant_id, movement_type, qty_delta, qty_before, qty_after,
    reference_type, reference_id, notes, created_by, owner_admin_id, created_at
  ) VALUES (
    p_product_id, p_variant_id, p_movement_type, p_qty_delta, v_qty_before, v_qty_after,
    p_reference_type, p_reference_id, p_notes, p_created_by, p_owner_admin_id, now()
  ) RETURNING id INTO v_ledger_id;

  RETURN v_ledger_id;
END;
$$;


--
-- Name: fn_track_price_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_track_price_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.purchase_price IS DISTINCT FROM NEW.purchase_price
     OR OLD.sale_price IS DISTINCT FROM NEW.sale_price THEN
    INSERT INTO product_price_history (
      product_id, old_purchase_price, new_purchase_price,
      old_sale_price, new_sale_price, reason, changed_by, created_at
    ) VALUES (
      NEW.id, OLD.purchase_price, NEW.purchase_price,
      OLD.sale_price, NEW.sale_price,
      'Actualización automática', NEW.created_by, now()
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: log_price_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_price_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Solo registrar si algún precio realmente cambió
  IF (
    OLD.purchase_price IS DISTINCT FROM NEW.purchase_price OR
    OLD.sale_price     IS DISTINCT FROM NEW.sale_price
  ) THEN
    INSERT INTO product_price_history (
      product_id,
      old_purchase_price,
      new_purchase_price,
      old_sale_price,
      new_sale_price,
      reason,
      changed_by,   -- NULL porque products no tiene updated_by
      created_at
    ) VALUES (
      NEW.id,
      OLD.purchase_price,
      NEW.purchase_price,
      OLD.sale_price,
      NEW.sale_price,
      'manual_adjustment',
      NULL,         -- ← antes era NEW.updated_by (columna inexistente)
      NOW()
    );
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: reduce_stock_on_sale(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reduce_stock_on_sale() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE products 
    SET stock = stock - NEW.quantity
    WHERE id = NEW.product_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Product not found';
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;


--
-- Name: set_updated_at_sales(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at_sales() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: track_product_cost_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_product_cost_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.purchase_price != NEW.purchase_price) THEN
        INSERT INTO product_cost_history (product_id, previous_cost, new_cost, change_reason)
        VALUES (NEW.id, OLD.purchase_price, NEW.purchase_price, 'Manual update');
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: track_product_price_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.track_product_price_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.sale_price != NEW.sale_price) THEN
        INSERT INTO product_price_history (product_id, previous_price, new_price)
        VALUES (NEW.id, OLD.sale_price, NEW.sale_price);
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: update_budget_spent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_budget_spent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE financial_budgets
  SET 
    spent_amount = (
      SELECT COALESCE(SUM(amount), 0)
      FROM expenses
      WHERE category = financial_budgets.category
        AND expense_date BETWEEN financial_budgets.period_start AND financial_budgets.period_end
    ),
    updated_at = NOW()
  WHERE category = NEW.category
    AND NEW.expense_date BETWEEN period_start AND period_end;
  
  RETURN NEW;
END;
$$;


--
-- Name: update_invoice_pending(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_invoice_pending() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE invoices
  SET pending_amount = total_amount - COALESCE(
    (SELECT SUM(amount) FROM invoice_payments WHERE invoice_id = NEW.invoice_id),
    0
  )
  WHERE id = NEW.invoice_id;
  
  RETURN NEW;
END;
$$;


--
-- Name: update_stock_on_po_receive(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_stock_on_po_receive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (NEW.status = 'received' AND OLD.status != 'received') THEN
        UPDATE products p SET
            stock = stock + poi.quantity,
            purchase_price = poi.unit_cost,
            markup_percentage = poi.markup_percentage,
            updated_at = NOW()
        FROM purchase_order_items poi
        WHERE poi.purchase_order_id = NEW.id
          AND poi.product_id = p.id;
          
        -- Registrar en historial de costos
        INSERT INTO product_cost_history (product_id, provider_id, purchase_order_id, previous_cost, new_cost, quantity_purchased, change_reason)
        SELECT 
            poi.product_id,
            NEW.provider_id,
            NEW.id,
            p.purchase_price,
            poi.unit_cost,
            poi.quantity,
            'Purchase order #' || NEW.order_number || ' received'
        FROM purchase_order_items poi
        JOIN products p ON p.id = poi.product_id
        WHERE poi.purchase_order_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_profiles (
    id integer NOT NULL,
    user_id integer NOT NULL,
    business_name character varying(255),
    tagline character varying(255),
    description text,
    tax_id character varying(50),
    logo_url text,
    logo_public_id text,
    favicon_url text,
    primary_color character varying(7) DEFAULT '#3B82F6'::character varying,
    secondary_color character varying(7) DEFAULT '#1E40AF'::character varying,
    accent_color character varying(7) DEFAULT '#F59E0B'::character varying,
    business_email character varying(255),
    business_phone character varying(30),
    website character varying(255),
    address text,
    city character varying(100),
    department character varying(100),
    country character varying(100) DEFAULT 'Colombia'::character varying,
    currency character varying(10) DEFAULT 'COP'::character varying,
    timezone character varying(60) DEFAULT 'America/Bogota'::character varying,
    social_links jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    default_fulfillment_mode public.fulfillment_mode_type DEFAULT 'stock'::public.fulfillment_mode_type NOT NULL,
    partial_shipment_allowed boolean DEFAULT false NOT NULL,
    auto_create_procurement_orders boolean DEFAULT true NOT NULL,
    finance_pin_hash character varying(255) DEFAULT NULL::character varying,
    store_navbar_bg character varying(7) DEFAULT '#0A0A0A'::character varying,
    store_navbar_text character varying(10) DEFAULT 'light'::character varying,
    store_page_bg character varying(7) DEFAULT '#FFFFFF'::character varying,
    store_font character varying(60) DEFAULT ''::character varying,
    CONSTRAINT admin_profiles_navbar_text_check CHECK (((store_navbar_text)::text = ANY ((ARRAY['light'::character varying, 'dark'::character varying])::text[])))
);


--
-- Name: COLUMN admin_profiles.finance_pin_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admin_profiles.finance_pin_hash IS 'Hash bcrypt del PIN de 4-6 dígitos para acceder al panel de finanzas. NULL = sin PIN configurado.';


--
-- Name: admin_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_profiles_id_seq OWNED BY public.admin_profiles.id;


--
-- Name: agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_conversations (
    id integer NOT NULL,
    user_id integer,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    preview text
);


--
-- Name: agent_conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_conversations_id_seq OWNED BY public.agent_conversations.id;


--
-- Name: api_key_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key_logs (
    id integer NOT NULL,
    api_key_id integer NOT NULL,
    endpoint character varying(255),
    method character varying(10),
    ip_address character varying(45),
    origin character varying(255),
    status_code integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: api_key_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_key_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_key_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_key_logs_id_seq OWNED BY public.api_key_logs.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id integer NOT NULL,
    admin_id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    key_prefix character varying(16) NOT NULL,
    key_hash character varying(255) NOT NULL,
    permissions jsonb DEFAULT '["products:read"]'::jsonb NOT NULL,
    allowed_origins text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_used_at timestamp without time zone,
    request_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: attribute_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attribute_types (
    id integer NOT NULL,
    name character varying(60) NOT NULL,
    slug character varying(70) NOT NULL,
    icon character varying(10) DEFAULT NULL::character varying,
    created_by integer
);


--
-- Name: attribute_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attribute_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attribute_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attribute_types_id_seq OWNED BY public.attribute_types.id;


--
-- Name: attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attribute_values (
    id integer NOT NULL,
    attribute_type_id integer NOT NULL,
    value character varying(100) NOT NULL,
    display_value character varying(100),
    hex_color character varying(7) DEFAULT NULL::character varying,
    sort_order integer DEFAULT 0
);


--
-- Name: attribute_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attribute_values_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attribute_values_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attribute_values_id_seq OWNED BY public.attribute_values.id;


--
-- Name: banners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banners (
    id integer NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    image_url text NOT NULL,
    button_text character varying(100) DEFAULT 'Ver más'::character varying,
    button_link character varying(255) DEFAULT '/productos'::character varying,
    is_active boolean DEFAULT true,
    display_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    created_by integer
);


--
-- Name: banners_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.banners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: banners_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.banners_id_seq OWNED BY public.banners.id;


--
-- Name: bundle_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bundle_items (
    id integer NOT NULL,
    bundle_id integer NOT NULL,
    product_id integer,
    variant_id integer,
    quantity integer DEFAULT 1 NOT NULL,
    is_gift boolean DEFAULT false,
    CONSTRAINT bundle_item_has_product CHECK ((product_id IS NOT NULL)),
    CONSTRAINT bundle_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: bundle_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bundle_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bundle_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bundle_items_id_seq OWNED BY public.bundle_items.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(120) NOT NULL,
    description text,
    image_url text,
    parent_id integer,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    created_by integer,
    owner_admin_id integer
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id integer NOT NULL,
    user_id integer,
    user_name character varying(255),
    message text DEFAULT ''::text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    recipient_id integer,
    edited_at timestamp without time zone,
    image_url text,
    read_at timestamp without time zone
);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;


--
-- Name: contact_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_messages (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    subject character varying(255),
    message text NOT NULL,
    status character varying(20) DEFAULT 'unread'::character varying,
    reply text,
    replied_at timestamp without time zone,
    replied_by integer,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT contact_messages_status_check CHECK (((status)::text = ANY ((ARRAY['unread'::character varying, 'read'::character varying, 'replied'::character varying])::text[])))
);


--
-- Name: contact_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_messages_id_seq OWNED BY public.contact_messages.id;


--
-- Name: coupon_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupon_usage (
    id integer NOT NULL,
    coupon_id integer NOT NULL,
    sale_id integer NOT NULL,
    discount_applied numeric(12,2) NOT NULL,
    used_by integer,
    used_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE coupon_usage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.coupon_usage IS 'Registro de uso de cupones en ventas';


--
-- Name: coupon_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupon_usage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupon_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupon_usage_id_seq OWNED BY public.coupon_usage.id;


--
-- Name: credit_payment_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_payment_schedule (
    id integer NOT NULL,
    sale_id integer NOT NULL,
    owner_admin_id integer NOT NULL,
    installment_num integer NOT NULL,
    due_date date NOT NULL,
    expected_amount numeric(12,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    paid_at timestamp with time zone,
    sale_payment_id integer,
    upcoming_notified_at timestamp with time zone,
    due_notified_at timestamp with time zone,
    overdue_notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_payment_schedule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.credit_payment_schedule_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: credit_payment_schedule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.credit_payment_schedule_id_seq OWNED BY public.credit_payment_schedule.id;


--
-- Name: discount_coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_coupons (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    discount_type character varying(20),
    discount_value numeric(10,2) NOT NULL,
    min_purchase_amount numeric(12,2) DEFAULT 0,
    max_discount_amount numeric(12,2),
    usage_limit integer,
    times_used integer DEFAULT 0,
    valid_from timestamp without time zone NOT NULL,
    valid_until timestamp without time zone NOT NULL,
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    owner_admin_id integer,
    scope character varying(10) DEFAULT 'all'::character varying NOT NULL,
    CONSTRAINT discount_coupons_discount_type_check CHECK (((discount_type)::text = ANY ((ARRAY['percentage'::character varying, 'fixed'::character varying])::text[]))),
    CONSTRAINT discount_coupons_scope_check CHECK (((scope)::text = ANY ((ARRAY['web'::character varying, 'pos'::character varying, 'all'::character varying])::text[])))
);


--
-- Name: TABLE discount_coupons; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.discount_coupons IS 'Cupones de descuento con códigos únicos para clientes';


--
-- Name: discount_coupons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discount_coupons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discount_coupons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discount_coupons_id_seq OWNED BY public.discount_coupons.id;


--
-- Name: discount_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discount_targets (
    id integer NOT NULL,
    discount_id integer NOT NULL,
    target_type character varying(20),
    target_id character varying(255) NOT NULL,
    CONSTRAINT discount_targets_target_type_check CHECK (((target_type)::text = ANY ((ARRAY['product'::character varying, 'category'::character varying])::text[])))
);


--
-- Name: discount_targets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discount_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discount_targets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discount_targets_id_seq OWNED BY public.discount_targets.id;


--
-- Name: discounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discounts (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    type character varying(20),
    value numeric(10,2) NOT NULL,
    starts_at timestamp without time zone NOT NULL,
    ends_at timestamp without time zone NOT NULL,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    min_purchase_amount numeric(12,2) DEFAULT 0,
    max_discount_amount numeric(12,2),
    usage_limit integer,
    times_used integer DEFAULT 0,
    code character varying(50),
    description text,
    created_by integer,
    updated_at timestamp without time zone DEFAULT now(),
    owner_admin_id integer,
    scope character varying(10) DEFAULT 'all'::character varying NOT NULL,
    CONSTRAINT discounts_scope_check CHECK (((scope)::text = ANY ((ARRAY['web'::character varying, 'pos'::character varying, 'all'::character varying])::text[]))),
    CONSTRAINT discounts_type_check CHECK (((type)::text = ANY ((ARRAY['percentage'::character varying, 'fixed'::character varying])::text[])))
);


--
-- Name: discounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discounts_id_seq OWNED BY public.discounts.id;


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id integer NOT NULL,
    expense_type public.expense_type NOT NULL,
    category character varying(100),
    description text NOT NULL,
    amount numeric(12,2) NOT NULL,
    payment_method public.payment_method_type,
    reference_number character varying(100),
    provider_id integer,
    purchase_order_id integer,
    created_by integer,
    expense_date date DEFAULT CURRENT_DATE,
    created_at timestamp without time zone DEFAULT now(),
    utility_type character varying(20),
    utility_value numeric(12,2) DEFAULT 0,
    product_id integer,
    quantity integer DEFAULT 1,
    discount_amount numeric(12,2) DEFAULT 0,
    tax_amount numeric(12,2) DEFAULT 0,
    notes text,
    approved_by integer,
    approved_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now(),
    updated_by integer,
    owner_admin_id integer,
    sale_id integer,
    sale_item_id integer,
    procurement_order_id integer,
    CONSTRAINT expenses_utility_type_check CHECK ((((utility_type)::text = ANY ((ARRAY['fixed'::character varying, 'percentage'::character varying])::text[])) OR (utility_type IS NULL)))
);


--
-- Name: expenses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expenses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expenses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expenses_id_seq OWNED BY public.expenses.id;


--
-- Name: financial_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_budgets (
    id integer NOT NULL,
    category character varying(100) NOT NULL,
    budget_amount numeric(15,2) NOT NULL,
    spent_amount numeric(15,2) DEFAULT 0,
    period_type character varying(20),
    period_start date NOT NULL,
    period_end date NOT NULL,
    alert_threshold numeric(5,2) DEFAULT 80.00,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    owner_admin_id integer,
    CONSTRAINT financial_budgets_period_type_check CHECK (((period_type)::text = ANY ((ARRAY['monthly'::character varying, 'quarterly'::character varying, 'yearly'::character varying])::text[])))
);


--
-- Name: TABLE financial_budgets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.financial_budgets IS 'Presupuestos financieros por categoría y período';


--
-- Name: financial_budgets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.financial_budgets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: financial_budgets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.financial_budgets_id_seq OWNED BY public.financial_budgets.id;


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    product_id integer NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    subtotal numeric(12,2) NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT invoice_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT invoice_items_subtotal_check CHECK ((subtotal >= (0)::numeric)),
    CONSTRAINT invoice_items_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: TABLE invoice_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_items IS 'Productos incluidos en facturas de compra (permite múltiples productos)';


--
-- Name: invoice_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_items_id_seq OWNED BY public.invoice_items.id;


--
-- Name: invoice_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_payments (
    id integer NOT NULL,
    invoice_id integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    payment_method character varying(20) DEFAULT 'cash'::character varying NOT NULL,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT invoice_payments_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: TABLE invoice_payments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoice_payments IS 'Registro de pagos realizados a facturas (permite pagos parciales)';


--
-- Name: invoice_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoice_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoice_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoice_payments_id_seq OWNED BY public.invoice_payments.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id integer NOT NULL,
    invoice_type character varying(20) NOT NULL,
    provider_id integer,
    invoice_number character varying(100),
    invoice_date date DEFAULT CURRENT_DATE NOT NULL,
    due_date date,
    description text NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    pending_amount numeric(12,2) DEFAULT 0 NOT NULL,
    payment_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    payment_method character varying(20) DEFAULT 'cash'::character varying,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    owner_admin_id integer,
    CONSTRAINT invoices_invoice_type_check CHECK (((invoice_type)::text = ANY ((ARRAY['service'::character varying, 'purchase'::character varying])::text[]))),
    CONSTRAINT invoices_payment_method_check CHECK (((payment_method)::text = ANY ((ARRAY['cash'::character varying, 'credit'::character varying, 'transfer'::character varying, 'check'::character varying])::text[]))),
    CONSTRAINT invoices_payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['paid'::character varying, 'pending'::character varying, 'partial'::character varying])::text[]))),
    CONSTRAINT invoices_total_amount_check CHECK ((total_amount > (0)::numeric))
);


--
-- Name: TABLE invoices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.invoices IS 'Facturas de servicios (luz, internet) y compras a proveedores';


--
-- Name: COLUMN invoices.invoice_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.invoice_type IS 'service = servicio (luz, internet), purchase = compra de productos';


--
-- Name: COLUMN invoices.pending_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.pending_amount IS 'Monto que falta por pagar (total_amount - suma de pagos)';


--
-- Name: COLUMN invoices.payment_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.invoices.payment_status IS 'paid = pagado completo, pending = sin pagar, partial = pago parcial';


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: notification_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_queue (
    id integer NOT NULL,
    owner_admin_id integer NOT NULL,
    recipient_user_id integer,
    recipient_phone character varying(25),
    recipient_email character varying(255),
    channel public.notification_channel_type NOT NULL,
    event public.notification_event_type NOT NULL,
    template_key character varying(80),
    rendered_subject text,
    rendered_message text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.notification_status_type DEFAULT 'pending'::public.notification_status_type NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    last_error text,
    provider character varying(40),
    provider_message_id character varying(255),
    scheduled_for timestamp without time zone DEFAULT now() NOT NULL,
    sent_at timestamp without time zone,
    reference_type character varying(40),
    reference_id integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_queue_id_seq OWNED BY public.notification_queue.id;


--
-- Name: notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_settings (
    id integer NOT NULL,
    admin_id integer NOT NULL,
    whatsapp_enabled boolean DEFAULT false NOT NULL,
    whatsapp_phone character varying(25),
    whatsapp_country_code character varying(5) DEFAULT '+57'::character varying NOT NULL,
    whatsapp_verified boolean DEFAULT false NOT NULL,
    email_enabled boolean DEFAULT true NOT NULL,
    push_enabled boolean DEFAULT true NOT NULL,
    events_enabled jsonb DEFAULT '["new_sale", "new_on_demand_sale", "procurement_needed", "procurement_overdue"]'::jsonb NOT NULL,
    quiet_hours_start time without time zone,
    quiet_hours_end time without time zone,
    timezone character varying(60) DEFAULT 'America/Bogota'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_settings_id_seq OWNED BY public.notification_settings.id;


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    id integer NOT NULL,
    template_key character varying(80) NOT NULL,
    channel public.notification_channel_type NOT NULL,
    event public.notification_event_type NOT NULL,
    language character varying(10) DEFAULT 'es'::character varying NOT NULL,
    subject_template text,
    body_template text NOT NULL,
    variables jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_templates_id_seq OWNED BY public.notification_templates.id;


--
-- Name: page_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.page_views (
    id integer NOT NULL,
    session_id character varying(60) NOT NULL,
    page character varying(255) NOT NULL,
    page_label character varying(255),
    referrer character varying(255),
    referrer_label character varying(255),
    time_on_prev integer,
    user_id integer,
    device character varying(20),
    screen_w integer,
    screen_h integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: page_views_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.page_views_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: page_views_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.page_views_id_seq OWNED BY public.page_views.id;


--
-- Name: payment_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_webhook_events (
    id integer NOT NULL,
    provider public.payment_provider_type NOT NULL,
    event_id character varying(255) NOT NULL,
    event_type character varying(100),
    provider_transaction_id character varying(255),
    signature_valid boolean DEFAULT false NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    processed_at timestamp without time zone,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE payment_webhook_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_webhook_events IS 'Bitácora de webhooks. event_id derivado de forma estable cuando el proveedor no lo entrega.';


--
-- Name: payment_webhook_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_webhook_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_webhook_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_webhook_events_id_seq OWNED BY public.payment_webhook_events.id;


--
-- Name: procurement_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procurement_orders (
    id integer NOT NULL,
    owner_admin_id integer NOT NULL,
    sale_id integer NOT NULL,
    sale_item_id integer NOT NULL,
    product_id integer NOT NULL,
    variant_id integer,
    supplier_id integer,
    purchase_order_id integer,
    quantity integer NOT NULL,
    estimated_unit_cost numeric(12,2),
    actual_unit_cost numeric(12,2),
    estimated_total numeric(12,2) GENERATED ALWAYS AS ((estimated_unit_cost * (quantity)::numeric)) STORED,
    actual_total numeric(12,2) GENERATED ALWAYS AS ((actual_unit_cost * (quantity)::numeric)) STORED,
    status public.procurement_order_status DEFAULT 'pending'::public.procurement_order_status NOT NULL,
    expected_delivery_date date,
    ordered_at timestamp without time zone,
    received_at timestamp without time zone,
    cancelled_at timestamp without time zone,
    cancellation_reason text,
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT procurement_orders_quantity_check CHECK ((quantity > 0))
);


--
-- Name: procurement_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.procurement_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: procurement_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.procurement_orders_id_seq OWNED BY public.procurement_orders.id;


--
-- Name: product_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_images (
    id integer NOT NULL,
    product_id integer NOT NULL,
    url text NOT NULL,
    is_main boolean DEFAULT false,
    display_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: product_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_images_id_seq OWNED BY public.product_images.id;


--
-- Name: product_price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_price_history (
    id integer NOT NULL,
    product_id integer NOT NULL,
    old_purchase_price numeric(12,2),
    new_purchase_price numeric(12,2),
    old_sale_price numeric(12,2),
    new_sale_price numeric(12,2),
    reason character varying(100),
    expense_id integer,
    changed_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: TABLE product_price_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.product_price_history IS 'Historial de cambios en precios de productos para auditoría';


--
-- Name: product_price_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_price_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_price_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_price_history_id_seq OWNED BY public.product_price_history.id;


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id integer NOT NULL,
    product_id integer NOT NULL,
    user_id integer NOT NULL,
    order_item_id integer,
    rating smallint NOT NULL,
    title character varying(120),
    body text,
    status character varying(20) DEFAULT 'approved'::character varying NOT NULL,
    helpful_count integer DEFAULT 0 NOT NULL,
    is_verified_purchase boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT reviews_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text, ('flagged'::character varying)::text])))
);


--
-- Name: product_review_stats; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.product_review_stats AS
 SELECT product_id,
    count(*) AS total_reviews,
    round(avg(rating), 1) AS avg_rating,
    count(*) FILTER (WHERE (rating = 5)) AS five_star,
    count(*) FILTER (WHERE (rating = 4)) AS four_star,
    count(*) FILTER (WHERE (rating = 3)) AS three_star,
    count(*) FILTER (WHERE (rating = 2)) AS two_star,
    count(*) FILTER (WHERE (rating = 1)) AS one_star,
    count(*) FILTER (WHERE (is_verified_purchase = true)) AS verified_count
   FROM public.reviews
  WHERE ((status)::text = 'approved'::text)
  GROUP BY product_id
  WITH NO DATA;


--
-- Name: product_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variants (
    id integer NOT NULL,
    product_id integer NOT NULL,
    sku character varying(100),
    sale_price numeric(12,2) DEFAULT NULL::numeric,
    stock integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    stock_reserved integer DEFAULT 0 NOT NULL,
    stock_safety integer DEFAULT 0 NOT NULL,
    CONSTRAINT product_variants_reserved_lte_stock CHECK ((stock_reserved <= stock)),
    CONSTRAINT product_variants_stock_check CHECK ((stock >= 0)),
    CONSTRAINT product_variants_stock_reserved_check CHECK ((stock_reserved >= 0)),
    CONSTRAINT product_variants_stock_safety_check CHECK ((stock_safety >= 0))
);


--
-- Name: product_variants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_variants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_variants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_variants_id_seq OWNED BY public.product_variants.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    sku character varying(50),
    description text,
    category_id integer,
    stock integer DEFAULT 0 NOT NULL,
    min_stock integer DEFAULT 5,
    max_stock integer DEFAULT 100,
    purchase_price numeric(12,2) DEFAULT 0,
    sale_price numeric(12,2) NOT NULL,
    markup_percentage numeric(5,2),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    markup_type character varying(20),
    markup_value numeric(5,2),
    has_variants boolean DEFAULT false,
    is_bundle boolean DEFAULT false,
    bundle_price numeric(12,2) DEFAULT NULL::numeric,
    created_by integer,
    owner_admin_id integer,
    stock_reserved integer DEFAULT 0 NOT NULL,
    stock_safety integer DEFAULT 0 NOT NULL,
    fulfillment_mode public.fulfillment_mode_type DEFAULT 'hybrid'::public.fulfillment_mode_type NOT NULL,
    default_supplier_id integer,
    supplier_lead_time_days integer,
    supplier_cost_estimate numeric(12,2),
    requires_advance_payment boolean DEFAULT false NOT NULL,
    auto_send_to_supplier boolean DEFAULT false NOT NULL,
    CONSTRAINT products_markup_type_check CHECK ((((markup_type)::text = ANY ((ARRAY['fixed'::character varying, 'percentage'::character varying])::text[])) OR (markup_type IS NULL))),
    CONSTRAINT products_purchase_price_check CHECK ((purchase_price >= (0)::numeric)),
    CONSTRAINT products_reserved_lte_stock CHECK ((stock_reserved <= stock)),
    CONSTRAINT products_sale_price_check CHECK ((sale_price >= (0)::numeric)),
    CONSTRAINT products_stock_check CHECK ((stock >= 0))
);


--
-- Name: products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;


--
-- Name: provider_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_payments (
    id integer NOT NULL,
    provider_id integer NOT NULL,
    purchase_order_id integer,
    amount numeric(15,2) NOT NULL,
    payment_method public.payment_method_type NOT NULL,
    reference_number character varying(100),
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: provider_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.provider_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.provider_payments_id_seq OWNED BY public.provider_payments.id;


--
-- Name: providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.providers (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    category public.provider_category NOT NULL,
    phone character varying(20),
    email character varying(255),
    address text,
    contact_person character varying(255),
    tax_id character varying(50),
    balance numeric(15,2) DEFAULT 0.00,
    credit_limit numeric(15,2) DEFAULT 0.00,
    payment_terms_days integer DEFAULT 30,
    reliability_score numeric(3,2) DEFAULT 5.00,
    lead_time_days integer DEFAULT 7,
    is_active boolean DEFAULT true,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    created_by integer,
    owner_admin_id integer
);


--
-- Name: providers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.providers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: providers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.providers_id_seq OWNED BY public.providers.id;


--
-- Name: purchase_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_order_items (
    id integer NOT NULL,
    purchase_order_id integer NOT NULL,
    product_id integer NOT NULL,
    quantity integer NOT NULL,
    unit_cost numeric(12,2) NOT NULL,
    subtotal numeric(15,2) NOT NULL,
    suggested_sale_price numeric(12,2),
    markup_percentage numeric(5,2),
    expected_profit_per_unit numeric(12,2),
    expected_total_profit numeric(15,2),
    received_quantity integer DEFAULT 0,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT purchase_order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT purchase_order_items_unit_cost_check CHECK ((unit_cost >= (0)::numeric))
);


--
-- Name: purchase_order_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_order_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_order_items_id_seq OWNED BY public.purchase_order_items.id;


--
-- Name: purchase_order_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_order_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purchase_orders (
    id integer NOT NULL,
    order_number character varying(50) NOT NULL,
    provider_id integer NOT NULL,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    expected_delivery_date date,
    received_date date,
    status public.order_status_type DEFAULT 'pending'::public.order_status_type,
    subtotal numeric(15,2) DEFAULT 0,
    tax_amount numeric(15,2) DEFAULT 0,
    shipping_cost numeric(15,2) DEFAULT 0,
    discount_amount numeric(15,2) DEFAULT 0,
    total_cost numeric(15,2) NOT NULL,
    payment_method public.payment_method_type,
    payment_status public.payment_status_type DEFAULT 'pending'::public.payment_status_type,
    notes text,
    created_by integer,
    approved_by integer,
    approved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    owner_admin_id integer
);


--
-- Name: purchase_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purchase_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purchase_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purchase_orders_id_seq OWNED BY public.purchase_orders.id;


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id integer NOT NULL,
    user_id integer,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    is_active boolean DEFAULT true,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.push_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.push_subscriptions_id_seq OWNED BY public.push_subscriptions.id;


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(255) NOT NULL,
    device_info text,
    expires_at timestamp without time zone NOT NULL,
    revoked boolean DEFAULT false,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;


--
-- Name: review_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_images (
    id integer NOT NULL,
    review_id integer NOT NULL,
    url text NOT NULL,
    public_id text NOT NULL,
    "position" smallint DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: review_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_images_id_seq OWNED BY public.review_images.id;


--
-- Name: review_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_reports (
    id integer NOT NULL,
    review_id integer NOT NULL,
    reported_by integer NOT NULL,
    reason character varying(60) NOT NULL,
    details text,
    resolved boolean DEFAULT false,
    resolved_by integer,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT review_reports_reason_check CHECK (((reason)::text = ANY (ARRAY[('spam'::character varying)::text, ('offensive'::character varying)::text, ('fake'::character varying)::text, ('other'::character varying)::text])))
);


--
-- Name: review_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_reports_id_seq OWNED BY public.review_reports.id;


--
-- Name: review_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_votes (
    id integer NOT NULL,
    review_id integer NOT NULL,
    user_id integer NOT NULL,
    helpful boolean NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: review_votes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_votes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_votes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_votes_id_seq OWNED BY public.review_votes.id;


--
-- Name: reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reviews_id_seq OWNED BY public.reviews.id;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id integer NOT NULL,
    name character varying(50) NOT NULL,
    description text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: sale_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_items (
    id integer NOT NULL,
    sale_id integer NOT NULL,
    product_id integer NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(12,2) NOT NULL,
    unit_cost numeric(12,2),
    subtotal numeric(12,2) NOT NULL,
    discount_amount numeric(12,2) DEFAULT 0,
    profit_per_unit numeric(12,2),
    total_profit numeric(12,2),
    created_at timestamp without time zone DEFAULT now(),
    original_unit_price numeric(12,2),
    discount_percentage numeric(5,2) DEFAULT 0,
    discount_id integer,
    notes text,
    variant_id integer,
    fulfillment_mode_snapshot public.fulfillment_mode_type DEFAULT 'stock'::public.fulfillment_mode_type NOT NULL,
    supplier_cost_at_sale numeric(12,2),
    actual_supplier_cost numeric(12,2),
    estimated_delivery_date date,
    item_delivery_status public.delivery_status_type DEFAULT 'pending'::public.delivery_status_type NOT NULL,
    delivered_at timestamp without time zone
);


--
-- Name: sale_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sale_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sale_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sale_items_id_seq OWNED BY public.sale_items.id;


--
-- Name: sale_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sale_number_seq
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sale_payment_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_payment_transactions (
    id integer NOT NULL,
    sale_id integer NOT NULL,
    owner_admin_id integer,
    store_payment_account_id integer,
    provider public.payment_provider_type NOT NULL,
    provider_transaction_id character varying(255),
    reference character varying(255) NOT NULL,
    amount_in_cents bigint NOT NULL,
    platform_fee_in_cents bigint DEFAULT 0 NOT NULL,
    gateway_fee_in_cents bigint DEFAULT 0 NOT NULL,
    net_amount_in_cents bigint,
    currency character varying(10) DEFAULT 'COP'::character varying NOT NULL,
    payment_method_type character varying(40),
    status public.gateway_transaction_status DEFAULT 'pending'::public.gateway_transaction_status NOT NULL,
    status_detail text,
    raw_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sale_payment_transactions_amount_check CHECK ((amount_in_cents > 0))
);


--
-- Name: COLUMN sale_payment_transactions.amount_in_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sale_payment_transactions.amount_in_cents IS 'Monto total en centavos (Wompi opera en centavos). Calcular SIEMPRE desde la venta.';


--
-- Name: COLUMN sale_payment_transactions.platform_fee_in_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sale_payment_transactions.platform_fee_in_cents IS 'Comisión de la plataforma. 0 en el modelo por suscripción; reservado para split futuro.';


--
-- Name: sale_payment_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sale_payment_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sale_payment_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sale_payment_transactions_id_seq OWNED BY public.sale_payment_transactions.id;


--
-- Name: sale_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sale_payments (
    id integer NOT NULL,
    sale_id integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    payment_method public.payment_method_type DEFAULT 'cash'::public.payment_method_type NOT NULL,
    notes text,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    proof_url text,
    proof_uploaded_at timestamp without time zone,
    CONSTRAINT sale_payments_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: sale_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sale_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sale_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sale_payments_id_seq OWNED BY public.sale_payments.id;


--
-- Name: sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales (
    id integer NOT NULL,
    sale_number character varying(50),
    customer_id integer,
    sale_date timestamp without time zone DEFAULT now(),
    subtotal numeric(12,2) NOT NULL,
    tax_amount numeric(12,2) DEFAULT 0,
    discount_amount numeric(12,2) DEFAULT 0,
    total numeric(12,2) NOT NULL,
    payment_method public.payment_method_type,
    payment_status public.payment_status_type DEFAULT 'pending'::public.payment_status_type,
    sale_type character varying(20) DEFAULT 'web'::character varying,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    shipping_address text,
    shipping_city character varying(100),
    shipping_notes text,
    shipping_lat numeric(10,8),
    shipping_lng numeric(11,8),
    customer_phone character varying(20),
    payment_proof_url text,
    payment_proof_uploaded_at timestamp without time zone,
    credit_due_date date,
    credit_notes text,
    amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
    owner_admin_id integer,
    discount_id integer,
    procurement_status public.procurement_status_type DEFAULT 'not_required'::public.procurement_status_type NOT NULL,
    delivery_status public.delivery_status_type DEFAULT 'pending'::public.delivery_status_type NOT NULL,
    delivered_at timestamp without time zone,
    revenue_recognized_at timestamp without time zone,
    estimated_delivery_date date,
    has_on_demand_items boolean DEFAULT false NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN sales.shipping_lat; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sales.shipping_lat IS 'Latitud de la dirección de envío (Google Places)';


--
-- Name: COLUMN sales.shipping_lng; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sales.shipping_lng IS 'Longitud de la dirección de envío (Google Places)';


--
-- Name: COLUMN sales.customer_phone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sales.customer_phone IS 'Teléfono de contacto del cliente';


--
-- Name: sales_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_id_seq OWNED BY public.sales.id;


--
-- Name: stock_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_alerts (
    id integer NOT NULL,
    owner_admin_id integer NOT NULL,
    product_id integer NOT NULL,
    variant_id integer,
    alert_type character varying(30) NOT NULL,
    threshold integer NOT NULL,
    current_value integer NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolved_at timestamp without time zone,
    purchase_order_id integer,
    notified boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    procurement_order_id integer,
    sale_id integer,
    CONSTRAINT stock_alerts_alert_type_check CHECK (((alert_type)::text = ANY ((ARRAY['low_stock'::character varying, 'out_of_stock'::character varying, 'overstock'::character varying, 'procurement_needed'::character varying, 'procurement_overdue'::character varying])::text[])))
);


--
-- Name: stock_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_alerts_id_seq OWNED BY public.stock_alerts.id;


--
-- Name: stock_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_ledger (
    id integer NOT NULL,
    product_id integer NOT NULL,
    variant_id integer,
    movement_type public.stock_movement_type NOT NULL,
    qty_delta integer NOT NULL,
    qty_before integer NOT NULL,
    qty_after integer NOT NULL,
    reference_id integer,
    reference_type character varying(30),
    notes text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    owner_admin_id integer
);


--
-- Name: stock_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_ledger_id_seq OWNED BY public.stock_ledger.id;


--
-- Name: stock_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_reservations (
    id integer NOT NULL,
    owner_admin_id integer NOT NULL,
    session_id character varying(80),
    user_id integer,
    sale_id integer,
    product_id integer NOT NULL,
    variant_id integer,
    quantity integer NOT NULL,
    status public.stock_reservation_status DEFAULT 'active'::public.stock_reservation_status NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    confirmed_at timestamp without time zone,
    released_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_reservations_quantity_check CHECK ((quantity > 0))
);


--
-- Name: stock_reservations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_reservations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_reservations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_reservations_id_seq OWNED BY public.stock_reservations.id;


--
-- Name: store_payment_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_payment_accounts (
    id integer NOT NULL,
    admin_id integer NOT NULL,
    provider public.payment_provider_type DEFAULT 'wompi'::public.payment_provider_type NOT NULL,
    environment public.payment_environment DEFAULT 'production'::public.payment_environment NOT NULL,
    public_key character varying(255),
    private_key_encrypted text,
    events_secret_encrypted text,
    integrity_secret_encrypted text,
    merchant_identifier character varying(255),
    status public.payment_account_status DEFAULT 'pending'::public.payment_account_status NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    connected_at timestamp without time zone,
    last_verified_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE store_payment_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.store_payment_accounts IS 'Credenciales de pasarela de cada tienda. Una tienda recibe el 100% de sus ventas.';


--
-- Name: COLUMN store_payment_accounts.private_key_encrypted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_payment_accounts.private_key_encrypted IS 'Llave privada de la pasarela CIFRADA (AES-256-GCM). Nunca en texto plano.';


--
-- Name: COLUMN store_payment_accounts.events_secret_encrypted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_payment_accounts.events_secret_encrypted IS 'Secreto de eventos de Wompi (cifrado). Valida la firma de los webhooks.';


--
-- Name: COLUMN store_payment_accounts.integrity_secret_encrypted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.store_payment_accounts.integrity_secret_encrypted IS 'Secreto de integridad de Wompi (cifrado). Firma la transacción en el checkout.';


--
-- Name: store_payment_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.store_payment_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: store_payment_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.store_payment_accounts_id_seq OWNED BY public.store_payment_accounts.id;


--
-- Name: subscription_coupon_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_coupon_usage (
    id integer NOT NULL,
    coupon_id integer NOT NULL,
    admin_id integer NOT NULL,
    subscription_id integer NOT NULL,
    invoice_id integer,
    discount_applied numeric(12,2) NOT NULL,
    used_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_coupon_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_coupon_usage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_coupon_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_coupon_usage_id_seq OWNED BY public.subscription_coupon_usage.id;


--
-- Name: subscription_coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_coupons (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    description text,
    coupon_type character varying(20) NOT NULL,
    discount_value numeric(10,2) DEFAULT 0 NOT NULL,
    free_months integer DEFAULT 0 NOT NULL,
    applicable_plans integer[],
    applies_to_cycle public.billing_cycle_type,
    max_uses integer,
    times_used integer DEFAULT 0 NOT NULL,
    valid_from timestamp without time zone DEFAULT now() NOT NULL,
    valid_until timestamp without time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_coupons_coupon_type_check CHECK (((coupon_type)::text = ANY ((ARRAY['percentage'::character varying, 'fixed'::character varying, 'free_months'::character varying, 'full_free'::character varying])::text[])))
);


--
-- Name: subscription_coupons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_coupons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_coupons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_coupons_id_seq OWNED BY public.subscription_coupons.id;


--
-- Name: subscription_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_invoices (
    id integer NOT NULL,
    subscription_id integer NOT NULL,
    admin_id integer NOT NULL,
    plan_id integer NOT NULL,
    invoice_number character varying(30) NOT NULL,
    billing_cycle public.billing_cycle_type DEFAULT 'monthly'::public.billing_cycle_type NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    payment_method character varying(40),
    payment_reference character varying(255),
    wompi_transaction_id character varying(255),
    paid_at timestamp without time zone,
    period_start date NOT NULL,
    period_end date NOT NULL,
    due_date date NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_invoices_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'void'::character varying, 'refunded'::character varying])::text[])))
);


--
-- Name: subscription_invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_invoices_id_seq OWNED BY public.subscription_invoices.id;


--
-- Name: subscription_plan_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plan_changes (
    id integer NOT NULL,
    subscription_id integer NOT NULL,
    admin_id integer NOT NULL,
    from_plan_id integer,
    to_plan_id integer,
    from_status public.subscription_status_type,
    to_status public.subscription_status_type,
    reason text,
    changed_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_plan_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_plan_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_plan_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_plan_changes_id_seq OWNED BY public.subscription_plan_changes.id;


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(100) NOT NULL,
    description text,
    tagline character varying(255),
    price_monthly numeric(12,2) DEFAULT 0 NOT NULL,
    price_yearly numeric(12,2),
    currency character varying(10) DEFAULT 'COP'::character varying,
    trial_days integer DEFAULT 0,
    max_products integer DEFAULT 50,
    max_users integer DEFAULT 3,
    max_admins integer DEFAULT 1,
    max_monthly_sales integer DEFAULT 200,
    max_api_keys integer DEFAULT 0,
    max_categories integer DEFAULT 10,
    max_banners integer DEFAULT 3,
    max_providers integer DEFAULT 10,
    storage_mb integer DEFAULT 500,
    has_analytics boolean DEFAULT false,
    has_ai_agent boolean DEFAULT false,
    has_api_access boolean DEFAULT false,
    has_multi_admin boolean DEFAULT false,
    has_custom_branding boolean DEFAULT false,
    has_wompi_payments boolean DEFAULT false,
    has_export boolean DEFAULT false,
    has_priority_support boolean DEFAULT false,
    has_push_notifications boolean DEFAULT false,
    has_financial_reports boolean DEFAULT false,
    has_purchase_orders boolean DEFAULT false,
    has_discount_system boolean DEFAULT true,
    color character varying(7) DEFAULT '#3B82F6'::character varying,
    badge_label character varying(50),
    icon character varying(50),
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    is_public boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    has_inventory boolean DEFAULT false
);


--
-- Name: subscription_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscription_plans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscription_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscription_plans_id_seq OWNED BY public.subscription_plans.id;


--
-- Name: subscription_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_usage (
    admin_id integer NOT NULL,
    products_count integer DEFAULT 0 NOT NULL,
    users_count integer DEFAULT 0 NOT NULL,
    categories_count integer DEFAULT 0 NOT NULL,
    providers_count integer DEFAULT 0 NOT NULL,
    banners_count integer DEFAULT 0 NOT NULL,
    api_keys_count integer DEFAULT 0 NOT NULL,
    monthly_sales_count integer DEFAULT 0 NOT NULL,
    storage_used_mb numeric(10,2) DEFAULT 0 NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id integer NOT NULL,
    admin_id integer NOT NULL,
    plan_id integer NOT NULL,
    status public.subscription_status_type DEFAULT 'trial'::public.subscription_status_type NOT NULL,
    billing_cycle public.billing_cycle_type DEFAULT 'monthly'::public.billing_cycle_type NOT NULL,
    trial_start date,
    trial_end date,
    current_period_start date,
    current_period_end date,
    next_billing_date date,
    amount_due numeric(12,2) DEFAULT 0 NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    cancelled_at timestamp without time zone,
    cancellation_reason text,
    grace_period_days integer DEFAULT 7 NOT NULL,
    grace_expires_at timestamp without time zone,
    coupon_id integer,
    discount_applied numeric(12,2) DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subscriptions_id_seq OWNED BY public.subscriptions.id;


--
-- Name: user_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_favorites (
    id integer NOT NULL,
    user_id integer NOT NULL,
    product_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_favorites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_favorites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_favorites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_favorites_id_seq OWNED BY public.user_favorites.id;


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id integer NOT NULL,
    user_id integer NOT NULL,
    role_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_roles_id_seq OWNED BY public.user_roles.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(255),
    password character varying(255) NOT NULL,
    cedula character varying(20) NOT NULL,
    name character varying(255) NOT NULL,
    phone character varying(20),
    city character varying(100),
    address text,
    is_verified boolean DEFAULT false,
    failed_login_attempts integer DEFAULT 0,
    locked_until timestamp without time zone,
    last_login timestamp without time zone,
    reset_token character varying(64),
    reset_expires timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    is_active boolean DEFAULT true,
    owner_admin_id integer,
    profile_image_url text,
    profile_image_public_id text
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: v_cashflow_detailed; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_cashflow_detailed AS
 SELECT date_trunc('day'::text, (date)::timestamp with time zone) AS date,
    sum(
        CASE
            WHEN (type = 'income'::text) THEN amount
            ELSE (0)::numeric
        END) AS daily_income,
    sum(
        CASE
            WHEN (type = 'expense'::text) THEN amount
            ELSE (0)::numeric
        END) AS daily_expenses,
    sum(
        CASE
            WHEN (type = 'income'::text) THEN amount
            ELSE (- amount)
        END) AS daily_balance
   FROM ( SELECT (sales.sale_date)::date AS date,
            'income'::text AS type,
            sales.total AS amount
           FROM public.sales
          WHERE (sales.payment_status = 'paid'::public.payment_status_type)
        UNION ALL
         SELECT expenses.expense_date AS date,
            'expense'::text AS type,
            expenses.amount
           FROM public.expenses) combined
  GROUP BY (date_trunc('day'::text, (date)::timestamp with time zone))
  ORDER BY (date_trunc('day'::text, (date)::timestamp with time zone)) DESC;


--
-- Name: VIEW v_cashflow_detailed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_cashflow_detailed IS 'Flujo de caja diario detallado';


--
-- Name: v_expenses_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_expenses_summary AS
 SELECT date_trunc('month'::text, (expense_date)::timestamp with time zone) AS period,
    expense_type,
    category,
    count(*) AS transaction_count,
    sum(amount) AS total_amount,
    avg(amount) AS avg_amount,
    min(amount) AS min_amount,
    max(amount) AS max_amount,
    count(DISTINCT provider_id) AS unique_providers
   FROM public.expenses
  GROUP BY (date_trunc('month'::text, (expense_date)::timestamp with time zone)), expense_type, category;


--
-- Name: VIEW v_expenses_summary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_expenses_summary IS 'Resumen de gastos agrupados por período y categoría';


--
-- Name: v_stock_disponible; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_stock_disponible AS
 SELECT p.id AS product_id,
    p.owner_admin_id,
    p.name,
    p.sku,
    p.has_variants,
    p.is_bundle,
    p.fulfillment_mode,
    p.purchase_price,
    p.sale_price,
    p.default_supplier_id,
    COALESCE(p.supplier_lead_time_days, pr.lead_time_days, 0) AS lead_time_days,
    p.supplier_cost_estimate,
    pv.id AS variant_id,
    pv.sku AS variant_sku,
        CASE
            WHEN p.has_variants THEN pv.stock
            ELSE p.stock
        END AS stock_fisico,
        CASE
            WHEN p.has_variants THEN pv.stock_reserved
            ELSE p.stock_reserved
        END AS reservado,
        CASE
            WHEN p.has_variants THEN pv.stock_safety
            ELSE p.stock_safety
        END AS safety_stock,
    GREATEST(0, ((
        CASE
            WHEN p.has_variants THEN pv.stock
            ELSE p.stock
        END -
        CASE
            WHEN p.has_variants THEN pv.stock_reserved
            ELSE p.stock_reserved
        END) -
        CASE
            WHEN p.has_variants THEN pv.stock_safety
            ELSE p.stock_safety
        END)) AS disponible_inmediato,
        CASE
            WHEN (p.fulfillment_mode = ANY (ARRAY['on_demand'::public.fulfillment_mode_type, 'hybrid'::public.fulfillment_mode_type])) THEN true
            ELSE false
        END AS can_order_on_demand,
    p.min_stock,
    p.max_stock,
    ((
        CASE
            WHEN p.has_variants THEN pv.stock
            ELSE p.stock
        END)::numeric * COALESCE(p.purchase_price, (0)::numeric)) AS inventory_value,
        CASE
            WHEN (p.fulfillment_mode = 'on_demand'::public.fulfillment_mode_type) THEN 'on_demand_only'::text
            WHEN ((p.fulfillment_mode = 'hybrid'::public.fulfillment_mode_type) AND (
            CASE
                WHEN p.has_variants THEN pv.stock
                ELSE p.stock
            END <= 0)) THEN 'available_on_demand'::text
            WHEN (
            CASE
                WHEN p.has_variants THEN pv.stock
                ELSE p.stock
            END <= 0) THEN 'out_of_stock'::text
            WHEN (GREATEST(0, ((
            CASE
                WHEN p.has_variants THEN pv.stock
                ELSE p.stock
            END -
            CASE
                WHEN p.has_variants THEN pv.stock_reserved
                ELSE p.stock_reserved
            END) -
            CASE
                WHEN p.has_variants THEN pv.stock_safety
                ELSE p.stock_safety
            END)) <= 0) THEN 'reserved_full'::text
            WHEN (
            CASE
                WHEN p.has_variants THEN pv.stock
                ELSE p.stock
            END <= p.min_stock) THEN 'low_stock'::text
            WHEN (
            CASE
                WHEN p.has_variants THEN pv.stock
                ELSE p.stock
            END >= p.max_stock) THEN 'overstock'::text
            ELSE 'normal'::text
        END AS stock_status
   FROM ((public.products p
     LEFT JOIN public.product_variants pv ON (((pv.product_id = p.id) AND (pv.is_active = true))))
     LEFT JOIN public.providers pr ON ((pr.id = p.default_supplier_id)))
  WHERE (p.is_active AND (((p.has_variants = true) AND (pv.id IS NOT NULL)) OR ((p.has_variants = false) AND (pv.id IS NULL))));


--
-- Name: v_inventory_valuation; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_inventory_valuation AS
 SELECT owner_admin_id,
    count(DISTINCT product_id) AS total_products,
    count(DISTINCT product_id) FILTER (WHERE (fulfillment_mode = 'stock'::public.fulfillment_mode_type)) AS stock_products,
    count(DISTINCT product_id) FILTER (WHERE (fulfillment_mode = 'on_demand'::public.fulfillment_mode_type)) AS on_demand_products,
    count(DISTINCT product_id) FILTER (WHERE (fulfillment_mode = 'hybrid'::public.fulfillment_mode_type)) AS hybrid_products,
    sum(stock_fisico) FILTER (WHERE (fulfillment_mode <> 'on_demand'::public.fulfillment_mode_type)) AS total_units,
    sum(reservado) FILTER (WHERE (fulfillment_mode <> 'on_demand'::public.fulfillment_mode_type)) AS total_reserved,
    sum(disponible_inmediato) FILTER (WHERE (fulfillment_mode <> 'on_demand'::public.fulfillment_mode_type)) AS total_available,
    sum(inventory_value) FILTER (WHERE (fulfillment_mode <> 'on_demand'::public.fulfillment_mode_type)) AS total_inventory_value,
    count(*) FILTER (WHERE (stock_status = 'out_of_stock'::text)) AS out_of_stock_count,
    count(*) FILTER (WHERE (stock_status = 'low_stock'::text)) AS low_stock_count,
    count(*) FILTER (WHERE (stock_status = ANY (ARRAY['on_demand_only'::text, 'available_on_demand'::text]))) AS on_demand_count
   FROM public.v_stock_disponible
  GROUP BY owner_admin_id;


--
-- Name: v_invoices_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_invoices_summary AS
 SELECT i.id,
    i.invoice_type,
    i.invoice_number,
    i.invoice_date,
    i.due_date,
    i.description,
    i.total_amount,
    i.pending_amount,
    i.payment_status,
    i.payment_method,
    p.name AS provider_name,
    p.category AS provider_category,
    ( SELECT count(*) AS count
           FROM public.invoice_items
          WHERE (invoice_items.invoice_id = i.id)) AS items_count,
        CASE
            WHEN (((i.payment_status)::text <> 'paid'::text) AND (i.due_date IS NOT NULL)) THEN GREATEST(0, (EXTRACT(day FROM (now() - (i.due_date)::timestamp with time zone)))::integer)
            ELSE 0
        END AS days_overdue,
    COALESCE(( SELECT sum(invoice_payments.amount) AS sum
           FROM public.invoice_payments
          WHERE (invoice_payments.invoice_id = i.id)), (0)::numeric) AS paid_amount,
    i.created_at,
    i.updated_at
   FROM (public.invoices i
     LEFT JOIN public.providers p ON ((p.id = i.provider_id)));


--
-- Name: v_pending_procurement; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pending_procurement AS
 SELECT po.owner_admin_id,
    po.supplier_id,
    pr.name AS supplier_name,
    pr.lead_time_days AS supplier_lead_time,
    count(*) AS pending_count,
    sum(po.quantity) AS total_units,
    sum(po.estimated_total) AS estimated_total,
    min(po.created_at) AS oldest_request_at,
    (EXTRACT(day FROM (now() - (min(po.created_at))::timestamp with time zone)))::integer AS days_oldest_pending,
    jsonb_agg(jsonb_build_object('procurement_order_id', po.id, 'sale_id', po.sale_id, 'sale_item_id', po.sale_item_id, 'product_id', po.product_id, 'product_name', p.name, 'variant_id', po.variant_id, 'quantity', po.quantity, 'estimated_unit_cost', po.estimated_unit_cost, 'estimated_total', po.estimated_total, 'created_at', po.created_at, 'expected_delivery_date', po.expected_delivery_date) ORDER BY po.created_at) AS items
   FROM ((public.procurement_orders po
     LEFT JOIN public.providers pr ON ((pr.id = po.supplier_id)))
     LEFT JOIN public.products p ON ((p.id = po.product_id)))
  WHERE (po.status = 'pending'::public.procurement_order_status)
  GROUP BY po.owner_admin_id, po.supplier_id, pr.name, pr.lead_time_days;


--
-- Name: v_products_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_products_full AS
 SELECT p.id,
    p.name,
    p.sku,
    p.description,
    p.category_id,
    p.stock,
    p.min_stock,
    p.max_stock,
    p.stock_reserved,
    p.stock_safety,
    GREATEST(0, ((p.stock - p.stock_reserved) - p.stock_safety)) AS stock_disponible,
    p.purchase_price,
    p.sale_price,
    p.markup_percentage,
    p.markup_type,
    p.markup_value,
    p.is_active,
    p.has_variants,
    p.is_bundle,
    p.created_at,
    p.updated_at,
    p.owner_admin_id,
    c.name AS category_name,
    c.slug AS category_slug,
    ( SELECT pi.url
           FROM public.product_images pi
          WHERE ((pi.product_id = p.id) AND (pi.is_main = true))
         LIMIT 1) AS main_image,
    (p.sale_price - p.purchase_price) AS profit_per_unit,
        CASE
            WHEN (p.purchase_price > (0)::numeric) THEN round((((p.sale_price - p.purchase_price) / p.purchase_price) * (100)::numeric), 2)
            ELSE (0)::numeric
        END AS actual_markup_percentage,
        CASE
            WHEN (p.stock <= 0) THEN 'out_of_stock'::text
            WHEN (GREATEST(0, ((p.stock - p.stock_reserved) - p.stock_safety)) <= 0) THEN 'out_of_stock'::text
            WHEN (p.stock <= p.min_stock) THEN 'low_stock'::text
            WHEN (p.stock >= p.max_stock) THEN 'overstock'::text
            ELSE 'normal'::text
        END AS stock_status
   FROM (public.products p
     LEFT JOIN public.categories c ON ((p.category_id = c.id)));


--
-- Name: v_profit_analysis; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_profit_analysis AS
 SELECT p.id,
    p.name,
    p.sku,
    p.category_id,
    c.name AS category_name,
    p.stock,
    p.stock_reserved,
    p.stock_safety,
    GREATEST(0, ((p.stock - p.stock_reserved) - p.stock_safety)) AS stock_disponible,
    p.purchase_price AS cost_price,
    p.sale_price,
    (p.sale_price - p.purchase_price) AS unit_profit,
        CASE
            WHEN (p.purchase_price > (0)::numeric) THEN round((((p.sale_price - p.purchase_price) / p.purchase_price) * (100)::numeric), 2)
            ELSE (0)::numeric
        END AS margin_pct,
    COALESCE(s.units_sold, (0)::bigint) AS units_sold,
    COALESCE(s.total_revenue, (0)::numeric) AS total_revenue,
    COALESCE(s.total_profit, (0)::numeric) AS realized_profit,
    COALESCE(s.avg_discount, (0)::numeric) AS avg_discount_per_sale,
    ((p.stock)::numeric * p.purchase_price) AS inventory_value,
        CASE
            WHEN (p.stock <= 0) THEN 'out_of_stock'::text
            WHEN (GREATEST(0, ((p.stock - p.stock_reserved) - p.stock_safety)) <= 0) THEN 'out_of_stock'::text
            WHEN (p.stock <= p.min_stock) THEN 'low_stock'::text
            WHEN (p.stock >= p.max_stock) THEN 'overstocked'::text
            ELSE 'normal'::text
        END AS stock_status
   FROM ((public.products p
     LEFT JOIN public.categories c ON ((p.category_id = c.id)))
     LEFT JOIN ( SELECT sale_items.product_id,
            sum(sale_items.quantity) AS units_sold,
            sum(sale_items.subtotal) AS total_revenue,
            sum(sale_items.total_profit) AS total_profit,
            avg(sale_items.discount_amount) AS avg_discount
           FROM public.sale_items
          GROUP BY sale_items.product_id) s ON ((s.product_id = p.id)))
  WHERE (p.is_active = true);


--
-- Name: v_profit_per_sale; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_profit_per_sale AS
SELECT
    NULL::integer AS sale_id,
    NULL::character varying(50) AS sale_number,
    NULL::integer AS owner_admin_id,
    NULL::integer AS customer_id,
    NULL::timestamp without time zone AS sale_date,
    NULL::timestamp without time zone AS delivered_at,
    NULL::timestamp without time zone AS revenue_recognized_at,
    NULL::numeric(12,2) AS revenue,
    NULL::public.delivery_status_type AS delivery_status,
    NULL::numeric AS total_cost_real,
    NULL::numeric AS profit_real,
    NULL::numeric AS margin_pct_real,
    NULL::bigint AS items_with_pending_cost;


--
-- Name: v_provider_balance; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_provider_balance AS
SELECT
    NULL::integer AS id,
    NULL::character varying(255) AS name,
    NULL::public.provider_category AS category,
    NULL::numeric(15,2) AS balance,
    NULL::numeric(15,2) AS credit_limit,
    NULL::boolean AS is_active,
    NULL::numeric AS total_purchases,
    NULL::bigint AS total_orders,
    NULL::numeric AS total_payments,
    NULL::numeric AS available_credit;


--
-- Name: v_purchase_orders_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_purchase_orders_summary AS
SELECT
    NULL::integer AS id,
    NULL::character varying(50) AS order_number,
    NULL::integer AS provider_id,
    NULL::date AS order_date,
    NULL::date AS expected_delivery_date,
    NULL::date AS received_date,
    NULL::public.order_status_type AS status,
    NULL::numeric(15,2) AS subtotal,
    NULL::numeric(15,2) AS tax_amount,
    NULL::numeric(15,2) AS shipping_cost,
    NULL::numeric(15,2) AS discount_amount,
    NULL::numeric(15,2) AS total_cost,
    NULL::public.payment_method_type AS payment_method,
    NULL::public.payment_status_type AS payment_status,
    NULL::text AS notes,
    NULL::integer AS created_by,
    NULL::integer AS approved_by,
    NULL::timestamp without time zone AS approved_at,
    NULL::timestamp without time zone AS created_at,
    NULL::timestamp without time zone AS updated_at,
    NULL::bigint AS items_count,
    NULL::character varying(255) AS provider_name;


--
-- Name: v_revenue_recognized; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_revenue_recognized AS
 SELECT owner_admin_id,
    date_trunc('day'::text, revenue_recognized_at) AS recognized_date,
    count(*) AS sales_count,
    sum(total) AS revenue,
    sum(total) FILTER (WHERE (has_on_demand_items = true)) AS revenue_on_demand,
    sum(total) FILTER (WHERE (has_on_demand_items = false)) AS revenue_stock
   FROM public.sales s
  WHERE (revenue_recognized_at IS NOT NULL)
  GROUP BY owner_admin_id, (date_trunc('day'::text, revenue_recognized_at));


--
-- Name: v_sales_awaiting_fulfillment; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_sales_awaiting_fulfillment AS
SELECT
    NULL::integer AS sale_id,
    NULL::character varying(50) AS sale_number,
    NULL::integer AS owner_admin_id,
    NULL::integer AS customer_id,
    NULL::character varying(255) AS customer_name,
    NULL::character varying(20) AS customer_phone,
    NULL::timestamp without time zone AS sale_date,
    NULL::numeric(12,2) AS total,
    NULL::public.payment_status_type AS payment_status,
    NULL::public.procurement_status_type AS procurement_status,
    NULL::public.delivery_status_type AS delivery_status,
    NULL::date AS estimated_delivery_date,
    NULL::boolean AS has_on_demand_items,
    NULL::bigint AS total_items,
    NULL::bigint AS on_demand_items,
    NULL::bigint AS delivered_items,
    NULL::bigint AS pending_procurements,
    NULL::bigint AS ordered_procurements,
    NULL::bigint AS received_procurements;


--
-- Name: v_sales_full; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_sales_full AS
SELECT
    NULL::integer AS id,
    NULL::character varying(50) AS sale_number,
    NULL::integer AS customer_id,
    NULL::timestamp without time zone AS sale_date,
    NULL::numeric(12,2) AS subtotal,
    NULL::numeric(12,2) AS tax_amount,
    NULL::numeric(12,2) AS discount_amount,
    NULL::numeric(12,2) AS total,
    NULL::public.payment_method_type AS payment_method,
    NULL::public.payment_status_type AS payment_status,
    NULL::character varying(20) AS sale_type,
    NULL::integer AS created_by,
    NULL::timestamp without time zone AS created_at,
    NULL::character varying(255) AS customer_name,
    NULL::character varying(255) AS customer_email,
    NULL::character varying(255) AS seller_name,
    NULL::bigint AS items_count,
    NULL::numeric AS total_profit,
    NULL::numeric AS profit_margin;


--
-- Name: variant_attribute_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.variant_attribute_values (
    id integer NOT NULL,
    variant_id integer NOT NULL,
    attribute_value_id integer NOT NULL
);


--
-- Name: variant_attribute_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.variant_attribute_values_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: variant_attribute_values_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.variant_attribute_values_id_seq OWNED BY public.variant_attribute_values.id;


--
-- Name: variant_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.variant_images (
    id integer NOT NULL,
    variant_id integer NOT NULL,
    url text NOT NULL,
    is_main boolean DEFAULT false,
    display_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: variant_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.variant_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: variant_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.variant_images_id_seq OWNED BY public.variant_images.id;


--
-- Name: admin_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_profiles ALTER COLUMN id SET DEFAULT nextval('public.admin_profiles_id_seq'::regclass);


--
-- Name: agent_conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations ALTER COLUMN id SET DEFAULT nextval('public.agent_conversations_id_seq'::regclass);


--
-- Name: api_key_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_logs ALTER COLUMN id SET DEFAULT nextval('public.api_key_logs_id_seq'::regclass);


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: attribute_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_types ALTER COLUMN id SET DEFAULT nextval('public.attribute_types_id_seq'::regclass);


--
-- Name: attribute_values id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_values ALTER COLUMN id SET DEFAULT nextval('public.attribute_values_id_seq'::regclass);


--
-- Name: banners id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banners ALTER COLUMN id SET DEFAULT nextval('public.banners_id_seq'::regclass);


--
-- Name: bundle_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_items ALTER COLUMN id SET DEFAULT nextval('public.bundle_items_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Name: chat_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);


--
-- Name: contact_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages ALTER COLUMN id SET DEFAULT nextval('public.contact_messages_id_seq'::regclass);


--
-- Name: coupon_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_usage ALTER COLUMN id SET DEFAULT nextval('public.coupon_usage_id_seq'::regclass);


--
-- Name: credit_payment_schedule id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_payment_schedule ALTER COLUMN id SET DEFAULT nextval('public.credit_payment_schedule_id_seq'::regclass);


--
-- Name: discount_coupons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_coupons ALTER COLUMN id SET DEFAULT nextval('public.discount_coupons_id_seq'::regclass);


--
-- Name: discount_targets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_targets ALTER COLUMN id SET DEFAULT nextval('public.discount_targets_id_seq'::regclass);


--
-- Name: discounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts ALTER COLUMN id SET DEFAULT nextval('public.discounts_id_seq'::regclass);


--
-- Name: expenses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses ALTER COLUMN id SET DEFAULT nextval('public.expenses_id_seq'::regclass);


--
-- Name: financial_budgets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_budgets ALTER COLUMN id SET DEFAULT nextval('public.financial_budgets_id_seq'::regclass);


--
-- Name: invoice_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items ALTER COLUMN id SET DEFAULT nextval('public.invoice_items_id_seq'::regclass);


--
-- Name: invoice_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments ALTER COLUMN id SET DEFAULT nextval('public.invoice_payments_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: notification_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_queue ALTER COLUMN id SET DEFAULT nextval('public.notification_queue_id_seq'::regclass);


--
-- Name: notification_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings ALTER COLUMN id SET DEFAULT nextval('public.notification_settings_id_seq'::regclass);


--
-- Name: notification_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates ALTER COLUMN id SET DEFAULT nextval('public.notification_templates_id_seq'::regclass);


--
-- Name: page_views id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_views ALTER COLUMN id SET DEFAULT nextval('public.page_views_id_seq'::regclass);


--
-- Name: payment_webhook_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_events ALTER COLUMN id SET DEFAULT nextval('public.payment_webhook_events_id_seq'::regclass);


--
-- Name: procurement_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders ALTER COLUMN id SET DEFAULT nextval('public.procurement_orders_id_seq'::regclass);


--
-- Name: product_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images ALTER COLUMN id SET DEFAULT nextval('public.product_images_id_seq'::regclass);


--
-- Name: product_price_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history ALTER COLUMN id SET DEFAULT nextval('public.product_price_history_id_seq'::regclass);


--
-- Name: product_variants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants ALTER COLUMN id SET DEFAULT nextval('public.product_variants_id_seq'::regclass);


--
-- Name: products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);


--
-- Name: provider_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_payments ALTER COLUMN id SET DEFAULT nextval('public.provider_payments_id_seq'::regclass);


--
-- Name: providers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers ALTER COLUMN id SET DEFAULT nextval('public.providers_id_seq'::regclass);


--
-- Name: purchase_order_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items ALTER COLUMN id SET DEFAULT nextval('public.purchase_order_items_id_seq'::regclass);


--
-- Name: purchase_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders ALTER COLUMN id SET DEFAULT nextval('public.purchase_orders_id_seq'::regclass);


--
-- Name: push_subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.push_subscriptions_id_seq'::regclass);


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);


--
-- Name: review_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_images ALTER COLUMN id SET DEFAULT nextval('public.review_images_id_seq'::regclass);


--
-- Name: review_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_reports ALTER COLUMN id SET DEFAULT nextval('public.review_reports_id_seq'::regclass);


--
-- Name: review_votes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_votes ALTER COLUMN id SET DEFAULT nextval('public.review_votes_id_seq'::regclass);


--
-- Name: reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews ALTER COLUMN id SET DEFAULT nextval('public.reviews_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: sale_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items ALTER COLUMN id SET DEFAULT nextval('public.sale_items_id_seq'::regclass);


--
-- Name: sale_payment_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payment_transactions ALTER COLUMN id SET DEFAULT nextval('public.sale_payment_transactions_id_seq'::regclass);


--
-- Name: sale_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments ALTER COLUMN id SET DEFAULT nextval('public.sale_payments_id_seq'::regclass);


--
-- Name: sales id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales ALTER COLUMN id SET DEFAULT nextval('public.sales_id_seq'::regclass);


--
-- Name: stock_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts ALTER COLUMN id SET DEFAULT nextval('public.stock_alerts_id_seq'::regclass);


--
-- Name: stock_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger ALTER COLUMN id SET DEFAULT nextval('public.stock_ledger_id_seq'::regclass);


--
-- Name: stock_reservations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations ALTER COLUMN id SET DEFAULT nextval('public.stock_reservations_id_seq'::regclass);


--
-- Name: store_payment_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payment_accounts ALTER COLUMN id SET DEFAULT nextval('public.store_payment_accounts_id_seq'::regclass);


--
-- Name: subscription_coupon_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage ALTER COLUMN id SET DEFAULT nextval('public.subscription_coupon_usage_id_seq'::regclass);


--
-- Name: subscription_coupons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupons ALTER COLUMN id SET DEFAULT nextval('public.subscription_coupons_id_seq'::regclass);


--
-- Name: subscription_invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices ALTER COLUMN id SET DEFAULT nextval('public.subscription_invoices_id_seq'::regclass);


--
-- Name: subscription_plan_changes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes ALTER COLUMN id SET DEFAULT nextval('public.subscription_plan_changes_id_seq'::regclass);


--
-- Name: subscription_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans ALTER COLUMN id SET DEFAULT nextval('public.subscription_plans_id_seq'::regclass);


--
-- Name: subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions ALTER COLUMN id SET DEFAULT nextval('public.subscriptions_id_seq'::regclass);


--
-- Name: user_favorites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites ALTER COLUMN id SET DEFAULT nextval('public.user_favorites_id_seq'::regclass);


--
-- Name: user_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles ALTER COLUMN id SET DEFAULT nextval('public.user_roles_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: variant_attribute_values id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_attribute_values ALTER COLUMN id SET DEFAULT nextval('public.variant_attribute_values_id_seq'::regclass);


--
-- Name: variant_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_images ALTER COLUMN id SET DEFAULT nextval('public.variant_images_id_seq'::regclass);


--
-- Name: admin_profiles admin_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_profiles
    ADD CONSTRAINT admin_profiles_pkey PRIMARY KEY (id);


--
-- Name: admin_profiles admin_profiles_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_profiles
    ADD CONSTRAINT admin_profiles_user_id_unique UNIQUE (user_id);


--
-- Name: agent_conversations agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (id);


--
-- Name: api_key_logs api_key_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_logs
    ADD CONSTRAINT api_key_logs_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: attribute_types attribute_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_types
    ADD CONSTRAINT attribute_types_pkey PRIMARY KEY (id);


--
-- Name: attribute_types attribute_types_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_types
    ADD CONSTRAINT attribute_types_slug_key UNIQUE (slug);


--
-- Name: attribute_values attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_values
    ADD CONSTRAINT attribute_values_pkey PRIMARY KEY (id);


--
-- Name: banners banners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banners
    ADD CONSTRAINT banners_pkey PRIMARY KEY (id);


--
-- Name: bundle_items bundle_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_items
    ADD CONSTRAINT bundle_items_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: contact_messages contact_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_pkey PRIMARY KEY (id);


--
-- Name: coupon_usage coupon_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_usage
    ADD CONSTRAINT coupon_usage_pkey PRIMARY KEY (id);


--
-- Name: credit_payment_schedule credit_payment_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_payment_schedule
    ADD CONSTRAINT credit_payment_schedule_pkey PRIMARY KEY (id);


--
-- Name: discount_coupons discount_coupons_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_coupons
    ADD CONSTRAINT discount_coupons_code_key UNIQUE (code);


--
-- Name: discount_coupons discount_coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_coupons
    ADD CONSTRAINT discount_coupons_pkey PRIMARY KEY (id);


--
-- Name: discount_targets discount_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_targets
    ADD CONSTRAINT discount_targets_pkey PRIMARY KEY (id);


--
-- Name: discounts discounts_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_code_key UNIQUE (code);


--
-- Name: discounts discounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: financial_budgets financial_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_budgets
    ADD CONSTRAINT financial_budgets_pkey PRIMARY KEY (id);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoice_payments invoice_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: notification_queue notification_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_queue
    ADD CONSTRAINT notification_queue_pkey PRIMARY KEY (id);


--
-- Name: notification_settings notification_settings_admin_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_admin_id_key UNIQUE (admin_id);


--
-- Name: notification_settings notification_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_channel_event_lang_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_channel_event_lang_unique UNIQUE (channel, event, language);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_template_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_template_key_key UNIQUE (template_key);


--
-- Name: page_views page_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.page_views
    ADD CONSTRAINT page_views_pkey PRIMARY KEY (id);


--
-- Name: payment_webhook_events payment_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_webhook_events
    ADD CONSTRAINT payment_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: procurement_orders procurement_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_pkey PRIMARY KEY (id);


--
-- Name: product_images product_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_pkey PRIMARY KEY (id);


--
-- Name: product_price_history product_price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_pkey PRIMARY KEY (id);


--
-- Name: product_variants product_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_pkey PRIMARY KEY (id);


--
-- Name: product_variants product_variants_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_sku_key UNIQUE (sku);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_sku_key UNIQUE (sku);


--
-- Name: provider_payments provider_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_payments
    ADD CONSTRAINT provider_payments_pkey PRIMARY KEY (id);


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);


--
-- Name: purchase_order_items purchase_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);


--
-- Name: purchase_orders purchase_orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_order_number_key UNIQUE (order_number);


--
-- Name: purchase_orders purchase_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: review_images review_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_images
    ADD CONSTRAINT review_images_pkey PRIMARY KEY (id);


--
-- Name: review_reports review_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_reports
    ADD CONSTRAINT review_reports_pkey PRIMARY KEY (id);


--
-- Name: review_reports review_reports_review_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_reports
    ADD CONSTRAINT review_reports_review_user_unique UNIQUE (review_id, reported_by);


--
-- Name: review_votes review_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_votes
    ADD CONSTRAINT review_votes_pkey PRIMARY KEY (id);


--
-- Name: review_votes review_votes_user_review_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_votes
    ADD CONSTRAINT review_votes_user_review_unique UNIQUE (user_id, review_id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_user_product_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_user_product_unique UNIQUE (user_id, product_id);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sale_items sale_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_pkey PRIMARY KEY (id);


--
-- Name: sale_payment_transactions sale_payment_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payment_transactions
    ADD CONSTRAINT sale_payment_transactions_pkey PRIMARY KEY (id);


--
-- Name: sale_payments sale_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_pkey PRIMARY KEY (id);


--
-- Name: sales sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);


--
-- Name: sales sales_sale_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_sale_number_key UNIQUE (sale_number);


--
-- Name: stock_alerts stock_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_pkey PRIMARY KEY (id);


--
-- Name: stock_ledger stock_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_pkey PRIMARY KEY (id);


--
-- Name: stock_reservations stock_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_pkey PRIMARY KEY (id);


--
-- Name: store_payment_accounts store_payment_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payment_accounts
    ADD CONSTRAINT store_payment_accounts_pkey PRIMARY KEY (id);


--
-- Name: subscription_coupon_usage subscription_coupon_usage_coupon_id_admin_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage
    ADD CONSTRAINT subscription_coupon_usage_coupon_id_admin_id_key UNIQUE (coupon_id, admin_id);


--
-- Name: subscription_coupon_usage subscription_coupon_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage
    ADD CONSTRAINT subscription_coupon_usage_pkey PRIMARY KEY (id);


--
-- Name: subscription_coupons subscription_coupons_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupons
    ADD CONSTRAINT subscription_coupons_code_key UNIQUE (code);


--
-- Name: subscription_coupons subscription_coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupons
    ADD CONSTRAINT subscription_coupons_pkey PRIMARY KEY (id);


--
-- Name: subscription_invoices subscription_invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: subscription_invoices subscription_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_pkey PRIMARY KEY (id);


--
-- Name: subscription_plan_changes subscription_plan_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes
    ADD CONSTRAINT subscription_plan_changes_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_slug_key UNIQUE (slug);


--
-- Name: subscription_usage subscription_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_usage
    ADD CONSTRAINT subscription_usage_pkey PRIMARY KEY (admin_id);


--
-- Name: subscriptions subscriptions_admin_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_admin_id_key UNIQUE (admin_id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: user_favorites user_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_pkey PRIMARY KEY (id);


--
-- Name: user_favorites user_favorites_user_id_product_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_user_id_product_id_key UNIQUE (user_id, product_id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_unique UNIQUE (user_id, role_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: variant_attribute_values variant_attribute_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_attribute_values
    ADD CONSTRAINT variant_attribute_values_pkey PRIMARY KEY (id);


--
-- Name: variant_attribute_values variant_attribute_values_variant_id_attribute_value_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_attribute_values
    ADD CONSTRAINT variant_attribute_values_variant_id_attribute_value_id_key UNIQUE (variant_id, attribute_value_id);


--
-- Name: variant_images variant_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_images
    ADD CONSTRAINT variant_images_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_conv_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_conv_user ON public.agent_conversations USING btree (user_id, updated_at DESC);


--
-- Name: idx_api_key_logs_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_key_logs_date ON public.api_key_logs USING btree (created_at);


--
-- Name: idx_api_key_logs_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_key_logs_key ON public.api_key_logs USING btree (api_key_id);


--
-- Name: idx_api_keys_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_active ON public.api_keys USING btree (is_active);


--
-- Name: idx_api_keys_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_admin ON public.api_keys USING btree (admin_id);


--
-- Name: idx_api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_hash ON public.api_keys USING btree (key_hash);


--
-- Name: idx_api_keys_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_prefix ON public.api_keys USING btree (key_prefix);


--
-- Name: idx_attr_values_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attr_values_type ON public.attribute_values USING btree (attribute_type_id);


--
-- Name: idx_attribute_types_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attribute_types_created_by ON public.attribute_types USING btree (created_by);


--
-- Name: idx_banners_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_banners_created_by ON public.banners USING btree (created_by);


--
-- Name: idx_budgets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budgets_category ON public.financial_budgets USING btree (category);


--
-- Name: idx_budgets_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budgets_period ON public.financial_budgets USING btree (period_start, period_end);


--
-- Name: idx_bundle_items_bundle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bundle_items_bundle ON public.bundle_items USING btree (bundle_id);


--
-- Name: idx_categories_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_active ON public.categories USING btree (is_active);


--
-- Name: idx_categories_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_created_by ON public.categories USING btree (created_by);


--
-- Name: idx_categories_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_owner ON public.categories USING btree (owner_admin_id);


--
-- Name: idx_categories_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_parent ON public.categories USING btree (parent_id);


--
-- Name: idx_categories_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_slug ON public.categories USING btree (slug);


--
-- Name: idx_chat_messages_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_date ON public.chat_messages USING btree (created_at);


--
-- Name: idx_contact_messages_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_messages_created ON public.contact_messages USING btree (created_at DESC);


--
-- Name: idx_contact_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_messages_status ON public.contact_messages USING btree (status);


--
-- Name: idx_coupon_usage_coupon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupon_usage_coupon ON public.coupon_usage USING btree (coupon_id);


--
-- Name: idx_coupon_usage_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupon_usage_sale ON public.coupon_usage USING btree (sale_id);


--
-- Name: idx_coupons_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_active ON public.discount_coupons USING btree (is_active, valid_from, valid_until);


--
-- Name: idx_coupons_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_code ON public.discount_coupons USING btree (code);


--
-- Name: idx_cps_due_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cps_due_check ON public.credit_payment_schedule USING btree (owner_admin_id, due_date, status) WHERE (status = 'pending'::text);


--
-- Name: idx_cps_sale_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cps_sale_id ON public.credit_payment_schedule USING btree (sale_id);


--
-- Name: idx_discount_coupons_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_coupons_owner ON public.discount_coupons USING btree (owner_admin_id);


--
-- Name: idx_discount_targets_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_targets_type ON public.discount_targets USING btree (target_type, target_id);


--
-- Name: idx_discounts_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discounts_active ON public.discounts USING btree (active, starts_at, ends_at);


--
-- Name: idx_discounts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discounts_owner ON public.discounts USING btree (owner_admin_id);


--
-- Name: idx_expenses_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_category ON public.expenses USING btree (category);


--
-- Name: idx_expenses_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date ON public.expenses USING btree (expense_date);


--
-- Name: idx_expenses_date_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date_type ON public.expenses USING btree (expense_date, expense_type);


--
-- Name: idx_expenses_expense_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_expense_type ON public.expenses USING btree (expense_type);


--
-- Name: idx_expenses_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_owner ON public.expenses USING btree (owner_admin_id);


--
-- Name: idx_expenses_procurement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_procurement ON public.expenses USING btree (procurement_order_id) WHERE (procurement_order_id IS NOT NULL);


--
-- Name: idx_expenses_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_product ON public.expenses USING btree (product_id);


--
-- Name: idx_expenses_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_provider ON public.expenses USING btree (provider_id);


--
-- Name: idx_expenses_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_sale ON public.expenses USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: idx_expenses_sale_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_sale_item ON public.expenses USING btree (sale_item_id) WHERE (sale_item_id IS NOT NULL);


--
-- Name: idx_expenses_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_type ON public.expenses USING btree (expense_type);


--
-- Name: idx_financial_budgets_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_financial_budgets_owner ON public.financial_budgets USING btree (owner_admin_id);


--
-- Name: idx_invoice_items_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_invoice ON public.invoice_items USING btree (invoice_id);


--
-- Name: idx_invoice_items_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_product ON public.invoice_items USING btree (product_id);


--
-- Name: idx_invoice_payments_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_payments_invoice ON public.invoice_payments USING btree (invoice_id);


--
-- Name: idx_invoices_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_date ON public.invoices USING btree (invoice_date);


--
-- Name: idx_invoices_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_owner ON public.invoices USING btree (owner_admin_id);


--
-- Name: idx_invoices_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_provider ON public.invoices USING btree (provider_id);


--
-- Name: idx_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_status ON public.invoices USING btree (payment_status);


--
-- Name: idx_invoices_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_type ON public.invoices USING btree (invoice_type);


--
-- Name: idx_notification_queue_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_queue_event ON public.notification_queue USING btree (event);


--
-- Name: idx_notification_queue_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_queue_owner ON public.notification_queue USING btree (owner_admin_id);


--
-- Name: idx_notification_queue_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_queue_pending ON public.notification_queue USING btree (scheduled_for) WHERE (status = 'pending'::public.notification_status_type);


--
-- Name: idx_notification_queue_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_queue_reference ON public.notification_queue USING btree (reference_type, reference_id) WHERE (reference_type IS NOT NULL);


--
-- Name: idx_notification_settings_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_settings_admin ON public.notification_settings USING btree (admin_id);


--
-- Name: idx_payment_webhook_events_txn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_webhook_events_txn ON public.payment_webhook_events USING btree (provider_transaction_id);


--
-- Name: idx_price_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_history_date ON public.product_price_history USING btree (created_at);


--
-- Name: idx_price_history_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_history_product ON public.product_price_history USING btree (product_id);


--
-- Name: idx_procurement_orders_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_owner ON public.procurement_orders USING btree (owner_admin_id);


--
-- Name: idx_procurement_orders_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_pending ON public.procurement_orders USING btree (owner_admin_id, supplier_id) WHERE (status = 'pending'::public.procurement_order_status);


--
-- Name: idx_procurement_orders_po; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_po ON public.procurement_orders USING btree (purchase_order_id);


--
-- Name: idx_procurement_orders_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_sale ON public.procurement_orders USING btree (sale_id);


--
-- Name: idx_procurement_orders_sale_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_sale_item ON public.procurement_orders USING btree (sale_item_id);


--
-- Name: idx_procurement_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_status ON public.procurement_orders USING btree (status);


--
-- Name: idx_procurement_orders_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_procurement_orders_supplier ON public.procurement_orders USING btree (supplier_id);


--
-- Name: idx_product_images_main; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_images_main ON public.product_images USING btree (product_id, is_main);


--
-- Name: idx_product_images_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_images_product ON public.product_images USING btree (product_id);


--
-- Name: idx_product_review_stats_product; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_product_review_stats_product ON public.product_review_stats USING btree (product_id);


--
-- Name: idx_products_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_active ON public.products USING btree (is_active);


--
-- Name: idx_products_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category ON public.products USING btree (category_id);


--
-- Name: idx_products_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_created_by ON public.products USING btree (created_by);


--
-- Name: idx_products_default_supplier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_default_supplier ON public.products USING btree (default_supplier_id);


--
-- Name: idx_products_fulfillment_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_fulfillment_mode ON public.products USING btree (fulfillment_mode);


--
-- Name: idx_products_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_owner ON public.products USING btree (owner_admin_id);


--
-- Name: idx_products_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_sku ON public.products USING btree (sku);


--
-- Name: idx_products_stock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_stock ON public.products USING btree (stock);


--
-- Name: idx_provider_payments_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provider_payments_provider ON public.provider_payments USING btree (provider_id);


--
-- Name: idx_providers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_providers_active ON public.providers USING btree (is_active);


--
-- Name: idx_providers_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_providers_category ON public.providers USING btree (category);


--
-- Name: idx_providers_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_providers_created_by ON public.providers USING btree (created_by);


--
-- Name: idx_providers_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_providers_owner ON public.providers USING btree (owner_admin_id);


--
-- Name: idx_purchase_order_items_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_order_items_order ON public.purchase_order_items USING btree (purchase_order_id);


--
-- Name: idx_purchase_order_items_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_order_items_product ON public.purchase_order_items USING btree (product_id);


--
-- Name: idx_purchase_orders_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_date ON public.purchase_orders USING btree (order_date);


--
-- Name: idx_purchase_orders_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_number ON public.purchase_orders USING btree (order_number);


--
-- Name: idx_purchase_orders_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_owner ON public.purchase_orders USING btree (owner_admin_id);


--
-- Name: idx_purchase_orders_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_provider ON public.purchase_orders USING btree (provider_id);


--
-- Name: idx_purchase_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_purchase_orders_status ON public.purchase_orders USING btree (status);


--
-- Name: idx_push_subs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_active ON public.push_subscriptions USING btree (is_active);


--
-- Name: idx_push_subs_ep; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_ep ON public.push_subscriptions USING btree (endpoint);


--
-- Name: idx_push_subs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_subs_user ON public.push_subscriptions USING btree (user_id);


--
-- Name: idx_pv_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pv_created ON public.page_views USING btree (created_at);


--
-- Name: idx_pv_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pv_page ON public.page_views USING btree (page);


--
-- Name: idx_pv_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pv_session ON public.page_views USING btree (session_id);


--
-- Name: idx_refresh_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_expires_at ON public.refresh_tokens USING btree (expires_at);


--
-- Name: idx_refresh_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_token_hash ON public.refresh_tokens USING btree (token_hash);


--
-- Name: idx_refresh_tokens_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refresh_tokens_user_id ON public.refresh_tokens USING btree (user_id);


--
-- Name: idx_review_images_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_images_review ON public.review_images USING btree (review_id);


--
-- Name: idx_review_reports_resolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_reports_resolved ON public.review_reports USING btree (resolved);


--
-- Name: idx_review_reports_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_reports_review ON public.review_reports USING btree (review_id);


--
-- Name: idx_review_votes_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_votes_review ON public.review_votes USING btree (review_id);


--
-- Name: idx_reviews_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_created ON public.reviews USING btree (created_at);


--
-- Name: idx_reviews_product_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_product_status ON public.reviews USING btree (product_id, status);


--
-- Name: idx_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_status ON public.reviews USING btree (status);


--
-- Name: idx_reviews_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_user ON public.reviews USING btree (user_id);


--
-- Name: idx_sale_items_delivery_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_items_delivery_status ON public.sale_items USING btree (item_delivery_status);


--
-- Name: idx_sale_items_fulfillment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_items_fulfillment ON public.sale_items USING btree (fulfillment_mode_snapshot);


--
-- Name: idx_sale_items_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_items_product ON public.sale_items USING btree (product_id);


--
-- Name: idx_sale_items_profit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_items_profit ON public.sale_items USING btree (total_profit);


--
-- Name: idx_sale_items_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_items_sale ON public.sale_items USING btree (sale_id);


--
-- Name: idx_sale_payment_txn_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_payment_txn_owner ON public.sale_payment_transactions USING btree (owner_admin_id);


--
-- Name: idx_sale_payment_txn_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_payment_txn_sale ON public.sale_payment_transactions USING btree (sale_id);


--
-- Name: idx_sale_payment_txn_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_payment_txn_status ON public.sale_payment_transactions USING btree (status);


--
-- Name: idx_sale_payments_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_payments_date ON public.sale_payments USING btree (payment_date);


--
-- Name: idx_sale_payments_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sale_payments_sale ON public.sale_payments USING btree (sale_id);


--
-- Name: idx_sales_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_customer ON public.sales USING btree (customer_id);


--
-- Name: idx_sales_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_date ON public.sales USING btree (sale_date);


--
-- Name: idx_sales_date_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_date_status ON public.sales USING btree (sale_date, payment_status);


--
-- Name: idx_sales_delivery_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_delivery_status ON public.sales USING btree (delivery_status);


--
-- Name: idx_sales_discount_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_discount_id ON public.sales USING btree (discount_id) WHERE (discount_id IS NOT NULL);


--
-- Name: idx_sales_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_number ON public.sales USING btree (sale_number);


--
-- Name: idx_sales_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_owner ON public.sales USING btree (owner_admin_id);


--
-- Name: idx_sales_procurement_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_procurement_status ON public.sales USING btree (procurement_status) WHERE (procurement_status <> 'not_required'::public.procurement_status_type);


--
-- Name: idx_sales_revenue_recognized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_revenue_recognized ON public.sales USING btree (revenue_recognized_at) WHERE (revenue_recognized_at IS NOT NULL);


--
-- Name: idx_sales_shipping_city; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_shipping_city ON public.sales USING btree (shipping_city);


--
-- Name: idx_sales_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_status ON public.sales USING btree (payment_status);


--
-- Name: idx_stock_alerts_no_duplicate; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_stock_alerts_no_duplicate ON public.stock_alerts USING btree (owner_admin_id, product_id, COALESCE(variant_id, 0), alert_type) WHERE (resolved = false);


--
-- Name: idx_stock_alerts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_alerts_owner ON public.stock_alerts USING btree (owner_admin_id);


--
-- Name: idx_stock_alerts_procurement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_alerts_procurement ON public.stock_alerts USING btree (procurement_order_id) WHERE (procurement_order_id IS NOT NULL);


--
-- Name: idx_stock_alerts_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_alerts_product ON public.stock_alerts USING btree (product_id);


--
-- Name: idx_stock_alerts_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_alerts_sale ON public.stock_alerts USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: idx_stock_alerts_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_alerts_unresolved ON public.stock_alerts USING btree (owner_admin_id, resolved) WHERE (resolved = false);


--
-- Name: idx_stock_ledger_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_created ON public.stock_ledger USING btree (created_at DESC);


--
-- Name: idx_stock_ledger_movement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_movement ON public.stock_ledger USING btree (movement_type);


--
-- Name: idx_stock_ledger_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_owner ON public.stock_ledger USING btree (owner_admin_id);


--
-- Name: idx_stock_ledger_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_product ON public.stock_ledger USING btree (product_id);


--
-- Name: idx_stock_ledger_product_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_product_date ON public.stock_ledger USING btree (product_id, created_at DESC);


--
-- Name: idx_stock_ledger_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_reference ON public.stock_ledger USING btree (reference_type, reference_id);


--
-- Name: idx_stock_ledger_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ledger_variant ON public.stock_ledger USING btree (variant_id) WHERE (variant_id IS NOT NULL);


--
-- Name: idx_stock_reservations_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_expiry ON public.stock_reservations USING btree (expires_at) WHERE (status = 'active'::public.stock_reservation_status);


--
-- Name: idx_stock_reservations_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_owner ON public.stock_reservations USING btree (owner_admin_id);


--
-- Name: idx_stock_reservations_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_product ON public.stock_reservations USING btree (product_id);


--
-- Name: idx_stock_reservations_sale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_sale ON public.stock_reservations USING btree (sale_id) WHERE (sale_id IS NOT NULL);


--
-- Name: idx_stock_reservations_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_session ON public.stock_reservations USING btree (session_id) WHERE (session_id IS NOT NULL);


--
-- Name: idx_stock_reservations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_status ON public.stock_reservations USING btree (status);


--
-- Name: idx_stock_reservations_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_user ON public.stock_reservations USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_stock_reservations_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_reservations_variant ON public.stock_reservations USING btree (variant_id) WHERE (variant_id IS NOT NULL);


--
-- Name: idx_store_payment_accounts_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_payment_accounts_admin ON public.store_payment_accounts USING btree (admin_id);


--
-- Name: idx_store_payment_accounts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_store_payment_accounts_status ON public.store_payment_accounts USING btree (status, is_active);


--
-- Name: idx_sub_changes_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_changes_admin ON public.subscription_plan_changes USING btree (admin_id);


--
-- Name: idx_sub_changes_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_changes_date ON public.subscription_plan_changes USING btree (created_at DESC);


--
-- Name: idx_sub_changes_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_changes_sub ON public.subscription_plan_changes USING btree (subscription_id);


--
-- Name: idx_sub_coupon_usage_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_coupon_usage_admin ON public.subscription_coupon_usage USING btree (admin_id);


--
-- Name: idx_sub_coupon_usage_coupon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_coupon_usage_coupon ON public.subscription_coupon_usage USING btree (coupon_id);


--
-- Name: idx_sub_coupons_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_coupons_active ON public.subscription_coupons USING btree (is_active, valid_from, valid_until);


--
-- Name: idx_sub_coupons_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_coupons_code ON public.subscription_coupons USING btree (code);


--
-- Name: idx_sub_invoices_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_invoices_admin ON public.subscription_invoices USING btree (admin_id);


--
-- Name: idx_sub_invoices_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_invoices_created ON public.subscription_invoices USING btree (created_at DESC);


--
-- Name: idx_sub_invoices_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_invoices_due ON public.subscription_invoices USING btree (due_date);


--
-- Name: idx_sub_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sub_invoices_status ON public.subscription_invoices USING btree (status);


--
-- Name: idx_subscriptions_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_admin ON public.subscriptions USING btree (admin_id);


--
-- Name: idx_subscriptions_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_due ON public.subscriptions USING btree (next_billing_date) WHERE (status = 'active'::public.subscription_status_type);


--
-- Name: idx_subscriptions_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_period ON public.subscriptions USING btree (current_period_end);


--
-- Name: idx_subscriptions_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_plan ON public.subscriptions USING btree (plan_id);


--
-- Name: idx_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_status ON public.subscriptions USING btree (status);


--
-- Name: idx_subscriptions_trial; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_trial ON public.subscriptions USING btree (trial_end) WHERE (status = 'trial'::public.subscription_status_type);


--
-- Name: idx_user_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_roles_role ON public.user_roles USING btree (role_id);


--
-- Name: idx_user_roles_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_roles_user ON public.user_roles USING btree (user_id);


--
-- Name: idx_users_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_active ON public.users USING btree (is_active);


--
-- Name: idx_users_cedula; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_cedula ON public.users USING btree (cedula);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_owner ON public.users USING btree (owner_admin_id);


--
-- Name: idx_var_attr_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_var_attr_variant ON public.variant_attribute_values USING btree (variant_id);


--
-- Name: idx_variants_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_variants_product ON public.product_variants USING btree (product_id);


--
-- Name: payment_webhook_events_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_webhook_events_unique ON public.payment_webhook_events USING btree (provider, event_id);


--
-- Name: sale_payment_transactions_provider_txn_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sale_payment_transactions_provider_txn_key ON public.sale_payment_transactions USING btree (provider, provider_transaction_id) WHERE (provider_transaction_id IS NOT NULL);


--
-- Name: sale_payment_transactions_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sale_payment_transactions_reference_key ON public.sale_payment_transactions USING btree (reference);


--
-- Name: store_payment_accounts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX store_payment_accounts_unique ON public.store_payment_accounts USING btree (admin_id, provider, environment);


--
-- Name: users_cedula_owner_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_cedula_owner_unique ON public.users USING btree (cedula, owner_admin_id) WHERE (owner_admin_id IS NOT NULL);


--
-- Name: users_cedula_platform_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_cedula_platform_unique ON public.users USING btree (cedula) WHERE (owner_admin_id IS NULL);


--
-- Name: users_email_owner_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_owner_unique ON public.users USING btree (email, owner_admin_id) WHERE ((owner_admin_id IS NOT NULL) AND (email IS NOT NULL));


--
-- Name: users_email_platform_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_platform_unique ON public.users USING btree (email) WHERE ((owner_admin_id IS NULL) AND (email IS NOT NULL));


--
-- Name: v_profit_per_sale _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_profit_per_sale AS
 SELECT s.id AS sale_id,
    s.sale_number,
    s.owner_admin_id,
    s.customer_id,
    s.sale_date,
    s.delivered_at,
    s.revenue_recognized_at,
    s.total AS revenue,
    s.delivery_status,
    sum(((si.quantity)::numeric * COALESCE(si.actual_supplier_cost, si.unit_cost, si.supplier_cost_at_sale, (0)::numeric))) AS total_cost_real,
    (s.total - sum(((si.quantity)::numeric * COALESCE(si.actual_supplier_cost, si.unit_cost, si.supplier_cost_at_sale, (0)::numeric)))) AS profit_real,
        CASE
            WHEN (s.total > (0)::numeric) THEN round((((s.total - sum(((si.quantity)::numeric * COALESCE(si.actual_supplier_cost, si.unit_cost, si.supplier_cost_at_sale, (0)::numeric)))) / s.total) * (100)::numeric), 2)
            ELSE (0)::numeric
        END AS margin_pct_real,
    count(si.id) FILTER (WHERE ((si.actual_supplier_cost IS NULL) AND (si.fulfillment_mode_snapshot <> 'stock'::public.fulfillment_mode_type))) AS items_with_pending_cost
   FROM (public.sales s
     LEFT JOIN public.sale_items si ON ((si.sale_id = s.id)))
  GROUP BY s.id;


--
-- Name: v_provider_balance _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_provider_balance AS
 SELECT p.id,
    p.name,
    p.category,
    p.balance,
    p.credit_limit,
    p.is_active,
    COALESCE(sum(po.total_cost), (0)::numeric) AS total_purchases,
    COALESCE(count(DISTINCT po.id), (0)::bigint) AS total_orders,
    COALESCE(sum(pp.amount), (0)::numeric) AS total_payments,
    (p.credit_limit - p.balance) AS available_credit
   FROM ((public.providers p
     LEFT JOIN public.purchase_orders po ON (((p.id = po.provider_id) AND (po.status <> 'cancelled'::public.order_status_type))))
     LEFT JOIN public.provider_payments pp ON ((p.id = pp.provider_id)))
  GROUP BY p.id;


--
-- Name: v_purchase_orders_summary _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_purchase_orders_summary AS
 SELECT po.id,
    po.order_number,
    po.provider_id,
    po.order_date,
    po.expected_delivery_date,
    po.received_date,
    po.status,
    po.subtotal,
    po.tax_amount,
    po.shipping_cost,
    po.discount_amount,
    po.total_cost,
    po.payment_method,
    po.payment_status,
    po.notes,
    po.created_by,
    po.approved_by,
    po.approved_at,
    po.created_at,
    po.updated_at,
    count(poi.id) AS items_count,
    p.name AS provider_name
   FROM ((public.purchase_orders po
     LEFT JOIN public.purchase_order_items poi ON ((poi.purchase_order_id = po.id)))
     LEFT JOIN public.providers p ON ((p.id = po.provider_id)))
  GROUP BY po.id, p.name;


--
-- Name: v_sales_awaiting_fulfillment _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_sales_awaiting_fulfillment AS
 SELECT s.id AS sale_id,
    s.sale_number,
    s.owner_admin_id,
    s.customer_id,
    u.name AS customer_name,
    u.phone AS customer_phone,
    s.sale_date,
    s.total,
    s.payment_status,
    s.procurement_status,
    s.delivery_status,
    s.estimated_delivery_date,
    s.has_on_demand_items,
    count(si.id) AS total_items,
    count(si.id) FILTER (WHERE (si.fulfillment_mode_snapshot <> 'stock'::public.fulfillment_mode_type)) AS on_demand_items,
    count(si.id) FILTER (WHERE (si.item_delivery_status = 'delivered'::public.delivery_status_type)) AS delivered_items,
    count(po.id) FILTER (WHERE (po.status = 'pending'::public.procurement_order_status)) AS pending_procurements,
    count(po.id) FILTER (WHERE (po.status = 'ordered_to_supplier'::public.procurement_order_status)) AS ordered_procurements,
    count(po.id) FILTER (WHERE (po.status = 'received'::public.procurement_order_status)) AS received_procurements
   FROM (((public.sales s
     LEFT JOIN public.users u ON ((u.id = s.customer_id)))
     LEFT JOIN public.sale_items si ON ((si.sale_id = s.id)))
     LEFT JOIN public.procurement_orders po ON ((po.sale_id = s.id)))
  WHERE (s.delivery_status <> ALL (ARRAY['delivered'::public.delivery_status_type, 'cancelled'::public.delivery_status_type]))
  GROUP BY s.id, u.name, u.phone;


--
-- Name: v_sales_full _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_sales_full AS
 SELECT s.id,
    s.sale_number,
    s.customer_id,
    s.sale_date,
    s.subtotal,
    s.tax_amount,
    s.discount_amount,
    s.total,
    s.payment_method,
    s.payment_status,
    s.sale_type,
    s.created_by,
    s.created_at,
    u.name AS customer_name,
    u.email AS customer_email,
    seller.name AS seller_name,
    count(DISTINCT si.id) AS items_count,
    COALESCE(sum(si.total_profit), (0)::numeric) AS total_profit,
    round(
        CASE
            WHEN (s.total > (0)::numeric) THEN ((COALESCE(sum(si.total_profit), (0)::numeric) / s.total) * (100)::numeric)
            ELSE (0)::numeric
        END, 2) AS profit_margin
   FROM (((public.sales s
     LEFT JOIN public.users u ON ((s.customer_id = u.id)))
     LEFT JOIN public.users seller ON ((s.created_by = seller.id)))
     LEFT JOIN public.sale_items si ON ((si.sale_id = s.id)))
  GROUP BY s.id, u.name, u.email, seller.name;


--
-- Name: products trg_log_price_changes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_log_price_changes AFTER UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.log_price_changes();


--
-- Name: products trg_product_price_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_price_change AFTER UPDATE OF purchase_price, sale_price ON public.products FOR EACH ROW EXECUTE FUNCTION public.fn_track_price_change();


--
-- Name: sales trg_sales_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sales_updated_at BEFORE UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_sales();


--
-- Name: stock_reservations trg_stock_reservations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stock_reservations_updated_at BEFORE UPDATE ON public.stock_reservations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: invoice_payments trg_update_invoice_pending; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_invoice_pending AFTER INSERT ON public.invoice_payments FOR EACH ROW EXECUTE FUNCTION public.update_invoice_pending();


--
-- Name: products trigger_log_price_changes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_log_price_changes AFTER UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.log_price_changes();


--
-- Name: expenses trigger_update_budget; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_budget AFTER INSERT OR DELETE OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.update_budget_spent();


--
-- Name: admin_profiles admin_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_profiles
    ADD CONSTRAINT admin_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_conversations agent_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: api_key_logs api_key_logs_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_logs
    ADD CONSTRAINT api_key_logs_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: attribute_types attribute_types_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_types
    ADD CONSTRAINT attribute_types_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: attribute_values attribute_values_attribute_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attribute_values
    ADD CONSTRAINT attribute_values_attribute_type_id_fkey FOREIGN KEY (attribute_type_id) REFERENCES public.attribute_types(id) ON DELETE CASCADE;


--
-- Name: banners banners_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banners
    ADD CONSTRAINT banners_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bundle_items bundle_items_bundle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_items
    ADD CONSTRAINT bundle_items_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: bundle_items bundle_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_items
    ADD CONSTRAINT bundle_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: bundle_items bundle_items_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bundle_items
    ADD CONSTRAINT bundle_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;


--
-- Name: categories categories_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: categories categories_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: chat_messages chat_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contact_messages contact_messages_replied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_replied_by_fkey FOREIGN KEY (replied_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: coupon_usage coupon_usage_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_usage
    ADD CONSTRAINT coupon_usage_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.discount_coupons(id) ON DELETE CASCADE;


--
-- Name: coupon_usage coupon_usage_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_usage
    ADD CONSTRAINT coupon_usage_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: coupon_usage coupon_usage_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_usage
    ADD CONSTRAINT coupon_usage_used_by_fkey FOREIGN KEY (used_by) REFERENCES public.users(id);


--
-- Name: credit_payment_schedule credit_payment_schedule_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_payment_schedule
    ADD CONSTRAINT credit_payment_schedule_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: credit_payment_schedule credit_payment_schedule_sale_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_payment_schedule
    ADD CONSTRAINT credit_payment_schedule_sale_payment_id_fkey FOREIGN KEY (sale_payment_id) REFERENCES public.sale_payments(id) ON DELETE SET NULL;


--
-- Name: discount_coupons discount_coupons_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_coupons
    ADD CONSTRAINT discount_coupons_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: discount_coupons discount_coupons_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_coupons
    ADD CONSTRAINT discount_coupons_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: discount_targets discount_targets_discount_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discount_targets
    ADD CONSTRAINT discount_targets_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES public.discounts(id) ON DELETE CASCADE;


--
-- Name: discounts discounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: discounts discounts_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discounts
    ADD CONSTRAINT discounts_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: expenses expenses_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_procurement_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_procurement_order_id_fkey FOREIGN KEY (procurement_order_id) REFERENCES public.procurement_orders(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: expenses expenses_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_sale_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_sale_item_id_fkey FOREIGN KEY (sale_item_id) REFERENCES public.sale_items(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: financial_budgets financial_budgets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_budgets
    ADD CONSTRAINT financial_budgets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: financial_budgets financial_budgets_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_budgets
    ADD CONSTRAINT financial_budgets_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoice_items invoice_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: invoice_payments invoice_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: invoice_payments invoice_payments_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_payments
    ADD CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: invoices invoices_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invoices invoices_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE SET NULL;


--
-- Name: notification_queue notification_queue_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_queue
    ADD CONSTRAINT notification_queue_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_queue notification_queue_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_queue
    ADD CONSTRAINT notification_queue_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_settings notification_settings_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: procurement_orders procurement_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: procurement_orders procurement_orders_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: procurement_orders procurement_orders_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: procurement_orders procurement_orders_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;


--
-- Name: procurement_orders procurement_orders_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: procurement_orders procurement_orders_sale_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_sale_item_id_fkey FOREIGN KEY (sale_item_id) REFERENCES public.sale_items(id) ON DELETE CASCADE;


--
-- Name: procurement_orders procurement_orders_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.providers(id) ON DELETE SET NULL;


--
-- Name: procurement_orders procurement_orders_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_orders
    ADD CONSTRAINT procurement_orders_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;


--
-- Name: product_images product_images_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_images
    ADD CONSTRAINT product_images_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_price_history product_price_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: product_price_history product_price_history_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id);


--
-- Name: product_price_history product_price_history_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_variants product_variants_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variants
    ADD CONSTRAINT product_variants_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL;


--
-- Name: products products_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: products products_default_supplier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_default_supplier_id_fkey FOREIGN KEY (default_supplier_id) REFERENCES public.providers(id) ON DELETE SET NULL;


--
-- Name: products products_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: provider_payments provider_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_payments
    ADD CONSTRAINT provider_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: provider_payments provider_payments_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_payments
    ADD CONSTRAINT provider_payments_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;


--
-- Name: provider_payments provider_payments_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_payments
    ADD CONSTRAINT provider_payments_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id);


--
-- Name: providers providers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: providers providers_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: purchase_order_items purchase_order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: purchase_order_items purchase_order_items_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE CASCADE;


--
-- Name: purchase_orders purchase_orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: purchase_orders purchase_orders_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: purchase_orders purchase_orders_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE RESTRICT;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_images review_images_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_images
    ADD CONSTRAINT review_images_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.reviews(id) ON DELETE CASCADE;


--
-- Name: review_reports review_reports_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_reports
    ADD CONSTRAINT review_reports_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_reports review_reports_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_reports
    ADD CONSTRAINT review_reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: review_reports review_reports_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_reports
    ADD CONSTRAINT review_reports_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.reviews(id) ON DELETE CASCADE;


--
-- Name: review_votes review_votes_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_votes
    ADD CONSTRAINT review_votes_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.reviews(id) ON DELETE CASCADE;


--
-- Name: review_votes review_votes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_votes
    ADD CONSTRAINT review_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.sale_items(id) ON DELETE SET NULL;


--
-- Name: reviews reviews_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: reviews reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sale_items sale_items_discount_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES public.discounts(id);


--
-- Name: sale_items sale_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: sale_items sale_items_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sale_items sale_items_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE SET NULL;


--
-- Name: sale_payment_transactions sale_payment_transactions_account_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payment_transactions
    ADD CONSTRAINT sale_payment_transactions_account_fkey FOREIGN KEY (store_payment_account_id) REFERENCES public.store_payment_accounts(id) ON DELETE SET NULL;


--
-- Name: sale_payment_transactions sale_payment_transactions_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payment_transactions
    ADD CONSTRAINT sale_payment_transactions_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sale_payment_transactions sale_payment_transactions_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payment_transactions
    ADD CONSTRAINT sale_payment_transactions_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sale_payments sale_payments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sale_payments sale_payments_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sale_payments
    ADD CONSTRAINT sale_payments_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE CASCADE;


--
-- Name: sales sales_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: sales sales_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sales sales_discount_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES public.discounts(id) ON DELETE SET NULL;


--
-- Name: sales sales_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stock_alerts stock_alerts_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: stock_alerts stock_alerts_procurement_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_procurement_order_id_fkey FOREIGN KEY (procurement_order_id) REFERENCES public.procurement_orders(id) ON DELETE SET NULL;


--
-- Name: stock_alerts stock_alerts_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: stock_alerts stock_alerts_purchase_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_purchase_order_id_fkey FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;


--
-- Name: stock_alerts stock_alerts_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;


--
-- Name: stock_alerts stock_alerts_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_alerts
    ADD CONSTRAINT stock_alerts_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;


--
-- Name: stock_ledger stock_ledger_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: stock_ledger stock_ledger_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id);


--
-- Name: stock_ledger stock_ledger_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: stock_ledger stock_ledger_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_ledger
    ADD CONSTRAINT stock_ledger_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id);


--
-- Name: stock_reservations stock_reservations_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: stock_reservations stock_reservations_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: stock_reservations stock_reservations_sale_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_sale_id_fkey FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;


--
-- Name: stock_reservations stock_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stock_reservations stock_reservations_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE RESTRICT;


--
-- Name: store_payment_accounts store_payment_accounts_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payment_accounts
    ADD CONSTRAINT store_payment_accounts_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscription_coupon_usage subscription_coupon_usage_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage
    ADD CONSTRAINT subscription_coupon_usage_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscription_coupon_usage subscription_coupon_usage_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage
    ADD CONSTRAINT subscription_coupon_usage_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.subscription_coupons(id) ON DELETE CASCADE;


--
-- Name: subscription_coupon_usage subscription_coupon_usage_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage
    ADD CONSTRAINT subscription_coupon_usage_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.subscription_invoices(id) ON DELETE SET NULL;


--
-- Name: subscription_coupon_usage subscription_coupon_usage_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupon_usage
    ADD CONSTRAINT subscription_coupon_usage_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscription_coupons subscription_coupons_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_coupons
    ADD CONSTRAINT subscription_coupons_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: subscription_invoices subscription_invoices_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscription_invoices subscription_invoices_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: subscription_invoices subscription_invoices_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_invoices
    ADD CONSTRAINT subscription_invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscription_plan_changes subscription_plan_changes_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes
    ADD CONSTRAINT subscription_plan_changes_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscription_plan_changes subscription_plan_changes_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes
    ADD CONSTRAINT subscription_plan_changes_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: subscription_plan_changes subscription_plan_changes_from_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes
    ADD CONSTRAINT subscription_plan_changes_from_plan_id_fkey FOREIGN KEY (from_plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: subscription_plan_changes subscription_plan_changes_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes
    ADD CONSTRAINT subscription_plan_changes_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.subscriptions(id) ON DELETE CASCADE;


--
-- Name: subscription_plan_changes subscription_plan_changes_to_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plan_changes
    ADD CONSTRAINT subscription_plan_changes_to_plan_id_fkey FOREIGN KEY (to_plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: subscription_usage subscription_usage_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_usage
    ADD CONSTRAINT subscription_usage_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.subscription_coupons(id) ON DELETE SET NULL;


--
-- Name: subscriptions subscriptions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: user_favorites user_favorites_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: user_favorites user_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_favorites
    ADD CONSTRAINT user_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_owner_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_owner_admin_id_fkey FOREIGN KEY (owner_admin_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: variant_attribute_values variant_attribute_values_attribute_value_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_attribute_values
    ADD CONSTRAINT variant_attribute_values_attribute_value_id_fkey FOREIGN KEY (attribute_value_id) REFERENCES public.attribute_values(id) ON DELETE CASCADE;


--
-- Name: variant_attribute_values variant_attribute_values_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_attribute_values
    ADD CONSTRAINT variant_attribute_values_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;


--
-- Name: variant_images variant_images_variant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.variant_images
    ADD CONSTRAINT variant_images_variant_id_fkey FOREIGN KEY (variant_id) REFERENCES public.product_variants(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict yIcdaXMCsKVZNDVbunpYmHgZeAngJUVk9fcSvZqmZkO0lLTJPAp9jLpmaN6bvER

