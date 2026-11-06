/*
 * La Ruta del Emprendedor: servidor del juego (GAES 1)
 * Autores: Daniel Velasco y Miguel Ortiz
 *
 * Por qué existe: un HTML solo guarda datos en el navegador de cada persona.
 * Para que el administrador vea los puntajes de TODOS los celulares, alguien
 * debe recibirlos en un punto central. Ese punto central es este archivo.
 *
 * Sin dependencias: solo módulos que ya trae Node.js (versión 18 o superior).
 * Uso: node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PUERTO = Number(process.env.PORT) || 3000;
const DIR_DATOS = process.env.DATA_DIR || path.join(__dirname, 'datos');
const ARCHIVO_PUNTAJES = path.join(DIR_DATOS, 'puntajes.json');
const ARCHIVO_ADMIN = path.join(DIR_DATOS, 'admin.json');
const ARCHIVO_JUEGO = path.join(__dirname, 'juego.html');
const USUARIO_ADMIN = process.env.ADMIN_USER || 'admin';
// Dirección pública cuando se publica en internet. Render define RENDER_EXTERNAL_URL por sí solo.
const URL_PUBLICA = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const DURACION_SESION_MS = 8 * 60 * 60 * 1000; // 8 horas
const MAX_CUERPO_BYTES = 16 * 1024;
const MAX_REGISTROS = 5000;

// Límites del juego. Deben coincidir con las reglas de juego.html.
const TOTAL_PREGUNTAS = 10;
const PUNTAJE_MAXIMO = 12400;
const MS_POR_PREGUNTA = 20000;

fs.mkdirSync(DIR_DATOS, { recursive: true });

/* ---------- Persistencia ---------- */

function leerJSON(archivo, porDefecto) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch {
    return porDefecto;
  }
}

// Escritura atómica: si el proceso se cae a la mitad, el archivo real sigue intacto.
function escribirJSON(archivo, datos) {
  const temporal = `${archivo}.tmp`;
  fs.writeFileSync(temporal, JSON.stringify(datos, null, 2));
  fs.renameSync(temporal, archivo);
}

let puntajes = leerJSON(ARCHIVO_PUNTAJES, []);

/* ---------- Contraseña del administrador ---------- */

// Nunca se guarda la contraseña: se guarda su derivación con scrypt y una sal aleatoria.
function derivar(clave, sal) {
  return crypto.scryptSync(clave, sal, 64);
}

function prepararAdmin() {
  if (process.env.ADMIN_PASSWORD) {
    const sal = crypto.randomBytes(16);
    return { sal, hash: derivar(process.env.ADMIN_PASSWORD, sal), generada: null };
  }
  const guardado = leerJSON(ARCHIVO_ADMIN, null);
  if (guardado) {
    return { sal: Buffer.from(guardado.sal, 'hex'), hash: Buffer.from(guardado.hash, 'hex'), generada: null };
  }
  // Primer arranque: se genera una contraseña y se muestra una sola vez en la consola.
  const generada = crypto.randomBytes(6).toString('base64url');
  const sal = crypto.randomBytes(16);
  const hash = derivar(generada, sal);
  escribirJSON(ARCHIVO_ADMIN, { sal: sal.toString('hex'), hash: hash.toString('hex') });
  return { sal, hash, generada };
}

const admin = prepararAdmin();

function credencialesValidas(usuario, clave) {
  const a = crypto.createHash('sha256').update(String(usuario)).digest();
  const b = crypto.createHash('sha256').update(USUARIO_ADMIN).digest();
  const usuarioOk = crypto.timingSafeEqual(a, b);
  // timingSafeEqual evita que el tiempo de respuesta revele cuántos bytes coincidieron.
  const claveOk = crypto.timingSafeEqual(derivar(String(clave), admin.sal), admin.hash);
  return usuarioOk && claveOk;
}

/* ---------- Sesiones y límites de intentos ---------- */

const sesiones = new Map(); // token -> fecha de vencimiento

function crearSesion() {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, Date.now() + DURACION_SESION_MS);
  return token;
}

function leerCookie(req, nombre) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const [clave, ...valor] = parte.trim().split('=');
    if (clave === nombre) return valor.join('=');
  }
  return null;
}

function sesionValida(req) {
  const token = leerCookie(req, 'ruta_admin');
  const vence = token && sesiones.get(token);
  if (!vence) return false;
  if (vence < Date.now()) {
    sesiones.delete(token);
    return false;
  }
  return true;
}

// Ventana fija simple. Suficiente para un solo proceso; con varios servidores se usaría Redis.
const contadores = new Map();

function excedeLimite(clave, maximo, ventanaMs) {
  const ahora = Date.now();
  const actual = contadores.get(clave);
  if (!actual || actual.reinicio < ahora) {
    contadores.set(clave, { total: 1, reinicio: ahora + ventanaMs });
    return false;
  }
  actual.total += 1;
  return actual.total > maximo;
}

setInterval(() => {
  const ahora = Date.now();
  for (const [k, v] of contadores) if (v.reinicio < ahora) contadores.delete(k);
  for (const [k, v] of sesiones) if (v < ahora) sesiones.delete(k);
}, 60000).unref();

function ipCliente(req) {
  // Detrás de un proxy (Render, por ejemplo) define TRUST_PROXY=1.
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'desconocida';
}

/* ---------- Validación ---------- */

function limpiarNombre(valor) {
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// El navegador nunca es confiable: se revisa todo lo que envía.
function validarPuntaje(c) {
  const nombre = limpiarNombre(c.nombre);
  if (nombre.length < 2) return { error: 'Escribe un nombre de al menos 2 letras.' };
  const puntaje = Number(c.puntaje);
  const aciertos = Number(c.aciertos);
  const mejorRacha = Number(c.mejorRacha);
  const tiempoPromedioMs = Number(c.tiempoPromedioMs);
  if (!Number.isInteger(puntaje) || puntaje < 0 || puntaje > PUNTAJE_MAXIMO) return { error: 'Puntaje fuera de rango.' };
  if (!Number.isInteger(aciertos) || aciertos < 0 || aciertos > TOTAL_PREGUNTAS) return { error: 'Aciertos fuera de rango.' };
  if (!Number.isInteger(mejorRacha) || mejorRacha < 0 || mejorRacha > aciertos) return { error: 'Racha fuera de rango.' };
  if (!Number.isFinite(tiempoPromedioMs) || tiempoPromedioMs < 0 || tiempoPromedioMs > MS_POR_PREGUNTA) return { error: 'Tiempo fuera de rango.' };
  if ((puntaje === 0) !== (aciertos === 0)) return { error: 'Puntaje y aciertos no coinciden.' };
  if (!Array.isArray(c.detalle) || c.detalle.length !== TOTAL_PREGUNTAS) return { error: 'Detalle incompleto.' };
  const detalle = c.detalle.map((d) => Boolean(d));
  if (detalle.filter(Boolean).length !== aciertos) return { error: 'El detalle no coincide con los aciertos.' };
  return {
    registro: {
      id: crypto.randomUUID(),
      nombre,
      puntaje,
      aciertos,
      total: TOTAL_PREGUNTAS,
      mejorRacha,
      tiempoPromedioMs: Math.round(tiempoPromedioMs),
      detalle,
      fecha: new Date().toISOString(),
    },
  };
}

/* ---------- Utilidades HTTP ---------- */

const CABECERAS_SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function responder(res, estado, cuerpo, extra = {}) {
  res.writeHead(estado, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CABECERAS_SEGURIDAD,
    ...extra,
  });
  res.end(JSON.stringify(cuerpo));
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      reject(Object.assign(new Error('Se esperaba JSON.'), { estado: 415 }));
      return;
    }
    let bytes = 0;
    const partes = [];
    req.on('data', (parte) => {
      bytes += parte.length;
      if (bytes > MAX_CUERPO_BYTES) {
        reject(Object.assign(new Error('Solicitud demasiado grande.'), { estado: 413 }));
        req.destroy();
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(partes).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON inválido.'), { estado: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function enlacesRed() {
  if (URL_PUBLICA) return [URL_PUBLICA];
  const enlaces = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const i of interfaces || []) {
      if (i.family === 'IPv4' && !i.internal) enlaces.push(`http://${i.address}:${PUERTO}`);
    }
  }
  return enlaces;
}

function esHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https';
}

function cookieSesion(req, token, maxAgeSegundos) {
  const seguro = esHttps(req) ? '; Secure' : '';
  return `ruta_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSegundos}${seguro}`;
}

/* ---------- Rutas ---------- */

async function atender(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ruta = url.pathname;
  const metodo = req.method;

  if (metodo === 'GET' && (ruta === '/' || ruta === '/juego.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...CABECERAS_SEGURIDAD,
    });
    fs.createReadStream(ARCHIVO_JUEGO).pipe(res);
    return;
  }

  if (metodo === 'GET' && ruta === '/api/estado') {
    responder(res, 200, { modo: 'servidor' });
    return;
  }

  // Ranking público: solo lo necesario para mostrar la tabla a los jugadores.
  if (metodo === 'GET' && ruta === '/api/ranking') {
    responder(res, 200, puntajes.map(({ id, nombre, puntaje, aciertos, tiempoPromedioMs }) => ({
      id, nombre, puntaje, aciertos, tiempoPromedioMs,
    })));
    return;
  }

  if (metodo === 'POST' && ruta === '/api/puntajes') {
    if (excedeLimite(`puntaje:${ipCliente(req)}`, 30, 60000)) {
      responder(res, 429, { error: 'Demasiados envíos seguidos. Espera un minuto.' });
      return;
    }
    if (puntajes.length >= MAX_REGISTROS) {
      responder(res, 507, { error: 'Se alcanzó el máximo de registros.' });
      return;
    }
    const { registro, error } = validarPuntaje(await leerCuerpo(req));
    if (error) {
      responder(res, 422, { error });
      return;
    }
    puntajes.push(registro);
    escribirJSON(ARCHIVO_PUNTAJES, puntajes);
    responder(res, 201, { id: registro.id });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/login') {
    // Dos límites: por IP y global. El global protege aunque alguien falsifique la IP detrás de un proxy.
    if (excedeLimite(`login:${ipCliente(req)}`, 5, 60000) || excedeLimite('login:global', 30, 60000)) {
      responder(res, 429, { error: 'Demasiados intentos. Espera un minuto.' });
      return;
    }
    const { usuario, clave } = await leerCuerpo(req);
    if (!credencialesValidas(usuario ?? '', clave ?? '')) {
      responder(res, 401, { error: 'Usuario o contraseña incorrectos.' });
      return;
    }
    const maxAge = Math.floor(DURACION_SESION_MS / 1000);
    responder(res, 200, { ok: true }, { 'Set-Cookie': cookieSesion(req, crearSesion(), maxAge) });
    return;
  }

  if (metodo === 'POST' && ruta === '/api/logout') {
    const token = leerCookie(req, 'ruta_admin');
    if (token) sesiones.delete(token);
    responder(res, 200, { ok: true }, { 'Set-Cookie': cookieSesion(req, '', 0) });
    return;
  }

  // A partir de aquí, todo exige sesión de administrador.
  if (ruta.startsWith('/api/admin/')) {
    if (!sesionValida(req)) {
      responder(res, 401, { error: 'Inicia sesión para continuar.' });
      return;
    }
    if (metodo === 'GET' && ruta === '/api/admin/puntajes') {
      responder(res, 200, { puntajes, enlaces: enlacesRed(), enlacePublico: Boolean(URL_PUBLICA) });
      return;
    }
    if (metodo === 'DELETE' && ruta === '/api/admin/puntajes') {
      puntajes = [];
      escribirJSON(ARCHIVO_PUNTAJES, puntajes);
      responder(res, 200, { ok: true });
      return;
    }
    const coincidencia = ruta.match(/^\/api\/admin\/puntajes\/([0-9a-f-]{36})$/);
    if (metodo === 'DELETE' && coincidencia) {
      puntajes = puntajes.filter((p) => p.id !== coincidencia[1]);
      escribirJSON(ARCHIVO_PUNTAJES, puntajes);
      responder(res, 200, { ok: true });
      return;
    }
  }

  responder(res, 404, { error: 'No encontrado.' });
}

const servidor = http.createServer((req, res) => {
  atender(req, res).catch((error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (!error.estado) console.error(error);
    responder(res, error.estado || 500, { error: error.estado ? error.message : 'Error interno del servidor.' });
  });
});

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log('\n  La Ruta del Emprendedor está en marcha\n');
  if (!URL_PUBLICA) console.log(`  En este equipo:      http://localhost:${PUERTO}`);
  for (const enlace of enlacesRed()) console.log(`  Para los jugadores:  ${enlace}`);
  console.log(`\n  Administrador:       botón "Administrador" del juego`);
  console.log(`  Usuario:             ${USUARIO_ADMIN}`);
  if (admin.generada) {
    console.log(`  Contraseña:          ${admin.generada}`);
    console.log('  Guárdala ahora: solo se muestra esta vez.');
  } else if (process.env.ADMIN_PASSWORD) {
    console.log('  Contraseña:          la definida en ADMIN_PASSWORD');
  } else {
    console.log('  Contraseña:          la mostrada en el primer arranque');
    console.log('  ¿La perdiste? Borra datos/admin.json y reinicia para generar otra.');
  }
  console.log('\n  Para detener el servidor: Ctrl + C\n');
});
