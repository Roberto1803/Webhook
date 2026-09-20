// Import Express.js and Anthropic SDK
const crypto = require('crypto');
const https = require('https');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;

// Create an Express app
const app = express();

// Guardamos el rawBody para poder validar la firma HMAC de Meta.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Set port and env vars
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const appSecret = process.env.WHATSAPP_APP_SECRET;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const graphVersion = process.env.META_GRAPH_VERSION;
const agentId = process.env.ANTHROPIC_AGENT_ID;
const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID;

const anthropic = new Anthropic();

// Sesión del agente por número de WhatsApp (en memoria; se reinicia si el dyno se reinicia).
const sesionesPorNumero = new Map();

// WhatsApp agrega un "1" extra a celulares mexicanos (52 1 XXXXXXXXXX) que no coincide
// con el formato que se registra en la lista de destinatarios autorizados (52 XXXXXXXXXX).
function normalizarNumeroMx(numero) {
  if (/^521\d{10}$/.test(numero)) {
    return '52' + numero.slice(3);
  }
  return numero;
}

function verificarFirma(req) {
  if (!appSecret) return true; // no bloquear si aún no se configuró el App Secret
  const firma = req.get('x-hub-signature-256');
  if (!firma || !req.rawBody) return false;

  const esperada = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');
  const bufferRecibido = Buffer.from(firma);
  const bufferEsperado = Buffer.from(esperada);
  if (bufferRecibido.length !== bufferEsperado.length) return false;
  return crypto.timingSafeEqual(bufferRecibido, bufferEsperado);
}

function enviarMensajeWhatsApp(destinatario, texto) {
  return new Promise((resolve, reject) => {
    const cuerpo = JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destinatario,
      type: 'text',
      text: { preview_url: false, body: texto },
    });

    const req = https.request(
      {
        hostname: 'graph.facebook.com',
        path: `/${graphVersion}/${phoneNumberId}/messages`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(cuerpo),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let resultado = {};
          try { resultado = JSON.parse(data); } catch (_) { /* respuesta vacía o no-JSON */ }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.error(`Meta respondió con HTTP ${res.statusCode}.`, data);
          }
          resolve(resultado);
        });
      },
    );

    req.on('error', (error) => {
      console.error('Error de red enviando a WhatsApp:', error);
      reject(error);
    });

    req.write(cuerpo);
    req.end();
  });
}

async function obtenerSesion(numero) {
  const existente = sesionesPorNumero.get(numero);
  if (existente) return existente;

  const session = await anthropic.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    title: `WhatsApp - ${numero}`,
    metadata: { whatsapp_number: numero },
  });

  sesionesPorNumero.set(numero, session.id);
  return session.id;
}

async function preguntarAlAgente(sessionId, pregunta) {
  const stream = await anthropic.beta.sessions.events.stream(sessionId);
  await anthropic.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: pregunta }] }],
  });

  let respuesta = '';
  for await (const event of stream) {
    if (event.type === 'agent.message') {
      for (const block of event.content) {
        if (block.type === 'text') respuesta += block.text;
      }
    } else if (event.type === 'session.status_terminated') {
      break;
    } else if (event.type === 'session.status_idle') {
      if (event.stop_reason && event.stop_reason.type === 'requires_action') continue;
      break;
    }
  }

  return respuesta.trim() || 'No obtuve una respuesta del agente, intenta de nuevo.';
}

async function procesarMensajeEntrante(numero, texto) {
  try {
    const sessionId = await obtenerSesion(numero);
    const respuesta = await preguntarAlAgente(sessionId, texto);
    await enviarMensajeWhatsApp(numero, respuesta);
  } catch (error) {
    console.error('Error procesando mensaje entrante:', error);
    await enviarMensajeWhatsApp(
      numero,
      'Tuvimos un problema respondiendo tu pregunta. Intenta de nuevo en un momento.',
    ).catch((err) => console.error('También falló el envío del mensaje de error:', err));
  }
}

// Route for GET requests (verificación del webhook)
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Route for POST requests (mensajes entrantes)
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  if (!verificarFirma(req)) {
    return res.status(401).end();
  }

  // Responder de inmediato; Meta reintenta si el webhook tarda o falla.
  res.status(200).end();

  const entradas = (req.body && req.body.entry) || [];
  for (const entrada of entradas) {
    const cambios = entrada.changes || [];
    for (const cambio of cambios) {
      const mensajes = (cambio.value && cambio.value.messages) || [];
      for (const mensaje of mensajes) {
        if (mensaje.type === 'text') {
          procesarMensajeEntrante(normalizarNumeroMx(mensaje.from), mensaje.text.body);
        }
      }
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
