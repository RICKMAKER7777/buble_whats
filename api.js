const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cors());
const PORT = process.env.PORT || 3000;

// Armazenamento em memória
let sessions = {};

// Criar pasta para sessões
const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Função para inicializar conexão WhatsApp
async function startWhatsAppSession(sessionId) {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, () => {}),
        },
        browser: ['Bubble WhatsApp', 'Chrome', '1.0.0'],
    });

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Evento de QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log(`QR Code recebido para ${sessionId}`);
            // Gerar QR Code em terminal e base64
            qrcode.generate(qr, { small: true });
            
            // Converter QR para base64
            const qrBuffer = Buffer.from(qr);
            const qrBase64 = qrBuffer.toString('base64');
            const qrDataURL = `data:image/png;base64,${qrBase64}`;
            
            sessions[sessionId].qrCode = qrDataURL;
            sessions[sessionId].isAuthenticated = false;
        }

        if (connection === 'open') {
            console.log(`WhatsApp conectado para sessão: ${sessionId}`);
            sessions[sessionId].isAuthenticated = true;
            sessions[sessionId].qrCode = null;
            sessions[sessionId].user = sock.user;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Conexão fechada. Reconectar? ${shouldReconnect}`);
            
            if (shouldReconnect) {
                startWhatsAppSession(sessionId);
            } else {
                delete sessions[sessionId];
                // Limpar pasta da sessão
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true });
                }
            }
        }
    });

    // Receber mensagens
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return; // Ignorar mensagens vazias
        
        const messageData = {
            id: msg.key.id,
            from: msg.key.remoteJid,
            pushName: msg.pushName,
            timestamp: msg.messageTimestamp,
            body: msg.message.conversation || 
                  msg.message.extendedTextMessage?.text ||
                  '[Mídia ou outro tipo]',
            type: Object.keys(msg.message)[0]
        };

        // Se for mídia
        if (msg.message.imageMessage || msg.message.videoMessage || msg.message.audioMessage) {
            try {
                const mediaType = msg.message.imageMessage ? 'image' : 
                                 msg.message.videoMessage ? 'video' : 'audio';
                const mediaMsg = msg.message[`${mediaType}Message`];
                
                messageData.media = {
                    type: mediaType,
                    mimetype: mediaMsg.mimetype,
                    caption: mediaMsg.caption,
                    url: mediaMsg.url
                };
            } catch (e) {
                console.error('Erro ao processar mídia:', e);
            }
        }

        if (!sessions[sessionId].messages) {
            sessions[sessionId].messages = [];
        }
        
        sessions[sessionId].messages.push(messageData);
        
        // Manter apenas últimas 100 mensagens
        if (sessions[sessionId].messages.length > 100) {
            sessions[sessionId].messages = sessions[sessionId].messages.slice(-100);
        }
    });

    return sock;
}

// 1. INICIAR SESSÃO
app.post('/sessions/start', async (req, res) => {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    
    if (sessions[sessionId]) {
        return res.status(400).json({ error: 'Sessão já existe' });
    }

    sessions[sessionId] = {
        isAuthenticated: false,
        qrCode: null,
        messages: [],
        user: null
    };

    try {
        const sock = await startWhatsAppSession(sessionId);
        sessions[sessionId].sock = sock;
        
        res.json({ 
            success: true, 
            sessionId: sessionId,
            message: 'Sessão iniciada. Use /sessions/[id]/qr para obter QR Code'
        });
    } catch (error) {
        console.error('Erro ao iniciar sessão:', error);
        delete sessions[sessionId];
        res.status(500).json({ error: error.message });
    }
});

// 2. LISTAR SESSÕES
app.get('/sessions', (req, res) => {
    const sessionList = Object.keys(sessions).map(id => ({
        id: id,
        isAuthenticated: sessions[id].isAuthenticated,
        user: sessions[id].user ? {
            id: sessions[id].user.id,
            name: sessions[id].user.name
        } : null,
        messageCount: sessions[id].messages?.length || 0
    }));
    res.json(sessionList);
});

// 3. OBTER QR CODE
app.get('/sessions/:id/qr', async (req, res) => {
    const sessionId = req.params.id;
    const session = sessions[sessionId];

    if (!session) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    if (session.isAuthenticated) {
        return res.json({ 
            status: 'authenticated',
            message: 'Sessão já autenticada',
            user: session.user
        });
    }

    if (session.qrCode) {
        res.json({ 
            qrCode: session.qrCode,
            status: 'waiting_qr'
        });
    } else {
        // Aguardar QR Code
        let attempts = 0;
        const checkQR = setInterval(() => {
            if (session.qrCode) {
                clearInterval(checkQR);
                res.json({ 
                    qrCode: session.qrCode,
                    status: 'waiting_qr'
                });
            }
            attempts++;
            if (attempts > 30) {
                clearInterval(checkQR);
                res.status(408).json({ error: 'Timeout aguardando QR Code' });
            }
        }, 1000);
    }
});

// 4. ENVIAR MENSAGEM DE TEXTO
app.post('/sessions/:id/send-message', async (req, res) => {
    const sessionId = req.params.id;
    const { number, message } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    if (!sessions[sessionId].isAuthenticated) {
        return res.status(400).json({ error: 'Sessão não autenticada' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
    }

    try {
        const sock = sessions[sessionId].sock;
        
        // Formatar número
        const formattedNumber = number.replace(/\D/g, '') + '@s.whatsapp.net';
        
        const result = await sock.sendMessage(formattedNumber, { text: message });
        
        res.json({ 
            success: true, 
            messageId: result.key.id,
            timestamp: new Date().getTime()
        });
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. ENVIAR IMAGEM
app.post('/sessions/:id/send-media', async (req, res) => {
    const sessionId = req.params.id;
    const { number, base64Data, mimeType, caption } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    if (!sessions[sessionId].isAuthenticated) {
        return res.status(400).json({ error: 'Sessão não autenticada' });
    }

    if (!number || !base64Data || !mimeType) {
        return res.status(400).json({ 
            error: 'Número, base64Data e mimeType são obrigatórios' 
        });
    }

    try {
        const sock = sessions[sessionId].sock;
        const formattedNumber = number.replace(/\D/g, '') + '@s.whatsapp.net';
        
        // Converter base64 para buffer
        const buffer = Buffer.from(base64Data.split(',')[1] || base64Data, 'base64');
        
        const result = await sock.sendMessage(formattedNumber, {
            image: buffer,
            mimetype: mimeType,
            caption: caption
        });
        
        res.json({ 
            success: true, 
            messageId: result.key.id,
            timestamp: new Date().getTime()
        });
    } catch (error) {
        console.error('Erro ao enviar mídia:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. RECEBER MENSAGENS
app.get('/sessions/:id/messages', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    res.json({
        success: true,
        count: sessions[sessionId].messages?.length || 0,
        messages: sessions[sessionId].messages || []
    });
});

// 7. STATUS DA SESSÃO
app.get('/sessions/:id/status', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    res.json({
        isAuthenticated: sessions[sessionId].isAuthenticated,
        qrAvailable: !!sessions[sessionId].qrCode,
        messageCount: sessions[sessionId].messages?.length || 0,
        user: sessions[sessionId].user,
        status: sessions[sessionId].isAuthenticated ? 'ready' : 'waiting_qr'
    });
});

// 8. REINICIAR SESSÃO
app.post('/sessions/:id/restore', async (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        if (sessions[sessionId].sock) {
            await sessions[sessionId].sock.end();
        }
        
        // Recomeçar sessão
        const sock = await startWhatsAppSession(sessionId);
        sessions[sessionId].sock = sock;
        sessions[sessionId].isAuthenticated = false;
        sessions[sessionId].qrCode = null;
        
        res.json({ success: true, message: 'Sessão reiniciada' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. DESTRUIR SESSÃO
app.delete('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        if (sessions[sessionId].sock) {
            await sessions[sessionId].sock.end();
        }
        
        // Remover pasta da sessão
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true });
        }
        
        delete sessions[sessionId];
        res.json({ success: true, message: 'Sessão destruída' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        version: 'Baileys WhatsApp API',
        sessions: Object.keys(sessions).length,
        endpoints: [
            'POST /sessions/start',
            'GET /sessions',
            'GET /sessions/:id/qr',
            'POST /sessions/:id/send-message',
            'POST /sessions/:id/send-media',
            'GET /sessions/:id/messages',
            'GET /sessions/:id/status',
            'POST /sessions/:id/restore',
            'DELETE /sessions/:id'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`WhatsApp Baileys API rodando na porta ${PORT}`);
});