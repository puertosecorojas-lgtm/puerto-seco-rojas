-- ============================================================
-- SCHEMA COMPLETO — Puerto Seco Rojas CRM
-- Pegar en Supabase > SQL Editor > Run
-- ============================================================

-- TABLA: leads
CREATE TABLE IF NOT EXISTS leads (
  id           BIGSERIAL PRIMARY KEY,
  nombre       TEXT NOT NULL,
  empresa      TEXT,
  tipo         TEXT DEFAULT 'despachante',
  ciudad       TEXT,
  zona         TEXT,
  email        TEXT,
  email_status TEXT DEFAULT 'sin_verificar',  -- 'verificado', 'invalido', 'sin_verificar'
  telefono     TEXT,
  web          TEXT,
  linkedin     TEXT,
  notas        TEXT,
  contactado   BOOLEAN DEFAULT FALSE,
  estado       TEXT DEFAULT 'sin_contactar',
  -- estados: sin_contactar | contactado | interesado | reunion_agendada | no_interesado | sin_respuesta
  fuente       TEXT DEFAULT 'manual',          -- 'apollo', 'hunter', 'manual', 'ia'
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- TABLA: configuracion (fila única id=1)
CREATE TABLE IF NOT EXISTS configuracion (
  id          INT DEFAULT 1 PRIMARY KEY,
  nombre      TEXT DEFAULT '',
  cargo       TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  telefono    TEXT DEFAULT '',
  direccion   TEXT DEFAULT '',
  servicios   TEXT DEFAULT '',
  firma       TEXT DEFAULT '',
  logo_url    TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- TABLA: emails_enviados
CREATE TABLE IF NOT EXISTS emails_enviados (
  id                  BIGSERIAL PRIMARY KEY,
  lead_id             BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  destinatario_email  TEXT NOT NULL,
  destinatario_nombre TEXT,
  empresa             TEXT,
  ciudad              TEXT,
  asunto              TEXT,
  cuerpo              TEXT,
  enfoques_usados     TEXT[],
  estado              TEXT DEFAULT 'enviado',
  -- estados: enviado | abierto | respondido | rebotado
  clasificacion_ia    TEXT DEFAULT '',
  -- urgente | interesado | consulta | reunion | sin_interes | sin_respuesta
  respuesta_recibida  TEXT DEFAULT '',
  fecha_envio         TIMESTAMPTZ DEFAULT NOW(),
  fecha_respuesta     TIMESTAMPTZ
);

-- TABLA: despachantes_aliados
CREATE TABLE IF NOT EXISTS despachantes_aliados (
  id        BIGSERIAL PRIMARY KEY,
  nombre    TEXT NOT NULL,
  empresa   TEXT,
  email     TEXT,
  telefono  TEXT,
  zona      TEXT,
  notas     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deshabilitar RLS (uso personal, un solo usuario)
ALTER TABLE leads                DISABLE ROW LEVEL SECURITY;
ALTER TABLE configuracion        DISABLE ROW LEVEL SECURITY;
ALTER TABLE emails_enviados      DISABLE ROW LEVEL SECURITY;
ALTER TABLE despachantes_aliados DISABLE ROW LEVEL SECURITY;

-- Configuración inicial (fila única)
INSERT INTO configuracion (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Índices útiles
CREATE INDEX IF NOT EXISTS idx_leads_email    ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_estado   ON leads(estado);
CREATE INDEX IF NOT EXISTS idx_leads_ciudad   ON leads(ciudad);
CREATE INDEX IF NOT EXISTS idx_enviados_email ON emails_enviados(destinatario_email);
CREATE INDEX IF NOT EXISTS idx_enviados_fecha ON emails_enviados(fecha_envio DESC);

-- ============================================================
-- DATOS DE MUESTRA (borrar si ya tenés leads cargados)
-- ============================================================
INSERT INTO leads (nombre, empresa, tipo, ciudad, zona, email, email_status, telefono, fuente) VALUES
('Juan Carlos Pereyra',  'Estudio Pereyra & Asoc.',      'estudio_aduanero',   'Junín',       'Bs.As. Centro',  'jpereyra@estudiopereyra.com.ar',   'verificado', '0236-15-401234', 'manual'),
('María Fernández',      'Despachante MF Comercio Ext.', 'despachante',        'Pergamino',   'Bs.As. Norte',   'mfernandez@mfcomex.com.ar',        'verificado', '02477-15-512345','manual'),
('Roberto Villagra',     'Logística Pampa S.R.L.',       'operador_logistico', 'Rosario',     'Santa Fe',       'rvillagra@logisticapampa.com.ar',  'verificado', '0341-15-623456', 'manual'),
('Graciela Soria',       'Soria Comex',                  'despachante',        'Chacabuco',   'Bs.As. Centro',  'gsoria@soriacomex.com.ar',         'verificado', '02352-15-734567','manual'),
('Eduardo Mansilla',     'Trans Córdoba S.A.',            'agente_transporte',  'Río Cuarto',  'Córdoba',        'emansilla@transcordoba.com.ar',    'verificado', '0358-15-845678', 'manual'),
('Luciana Bianchi',      'Bianchi Aduanas',              'estudio_aduanero',   'Venado Tuerto','Santa Fe',      'lbianchi@bianchiaduanas.com.ar',   'verificado', '03462-15-956789','manual'),
('Marcelo Fontán',       'Fontán Logística',             'operador_logistico', 'San Nicolás', 'Bs.As. Norte',   'mfontan@fontanlogistica.com.ar',   'sin_verificar','0336-15-067890', 'manual'),
('Silvia Romero',        'Romero & Hijos Comex',         'estudio_aduanero',   'Villa María', 'Córdoba',        'sromero@romerohijoscomex.com.ar',  'verificado', '0353-15-178901', 'manual'),
('Alberto Giménez',      'Giménez Despachos',            'despachante',        'Rafaela',     'Santa Fe',       'agimenez@gimenezdespachos.com.ar', 'verificado', '03492-15-289012','manual'),
('Patricia Leiva',       'Leiva Comercio Exterior',      'estudio_aduanero',   'Azul',        'Bs.As. Centro',  'pleiva@leivacomex.com.ar',         'verificado', '02281-15-390123','manual')
ON CONFLICT DO NOTHING;
