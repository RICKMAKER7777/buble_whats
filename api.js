const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cors());
const PORT = process.env.PORT || 3000;

// Armazenamento em memória (será persistido via variáveis de ambiente)
let sessions = {};
let sessionStates = {};

// Carregar sessões salvas das variáveis de ambiente
if (process.env.WHATSAPP_SESSIONS) {
    try {
        sessions = JSON.parse(Buffer.from(process.env.WHATSAPP_SESSIONS, 'base64').toString());
    } catch (e) {
        console.log('Nenhuma sessão salva encontrada');
    }
}

// Função para salvar sessões em base64 (para persistência)
function saveSessions() {
    const sessionsBase64 = Buffer.from(JSON.stringify(sessions)).toString('base64');
    console.log(`SESSIONS_BASE64: ${sessionsBase64}`);
    // No Render, você pode configurar esta variável de ambiente manualmente
    // ou usar o painel para atualizar após cada reinicialização
}

// 1. INICIAR SESSÃO
app.post('/sessions/start', async (req, res) => {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    
    if (sessions[sessionId]) {
        return res.status(400).json({ error: 'Sessão já existe' });
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    sessions[sessionId] = {
        client: client,
        qrCode: null,
        isAuthenticated: false,
        messages: []
    };

    sessionStates[sessionId] = {
        qr: null,
        ready: false
    };

    client.on('qr', async (qr) => {
        sessionStates[sessionId].qr = qr;
        sessions[sessionId].qrCode = await qrcode.toDataURL(qr);
    });

    client.on('ready', () => {
        console.log(`Sessão ${sessionId} pronta!`);
        sessions[sessionId].isAuthenticated = true;
        sessionStates[sessionId].ready = true;
        saveSessions();
    });

    client.on('message', async (msg) => {
        const messageData = {
            id: msg.id._serialized,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            timestamp: msg.timestamp,
            hasMedia: msg.hasMedia,
            type: msg.type
        };

        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                messageData.media = {
                    data: media.data,
                    mimetype: media.mimetype,
                    filename: media.filename
                };
            } catch (e) {
                console.error('Erro ao baixar mídia:', e);
            }
        }

        sessions[sessionId].messages.push(messageData);
        
        // Limitar histórico a 100 mensagens
        if (sessions[sessionId].messages.length > 100) {
            sessions[sessionId].messages = sessions[sessionId].messages.slice(-100);
        }
    });

    client.on('disconnected', (reason) => {
        console.log(`Sessão ${sessionId} desconectada:`, reason);
        delete sessions[sessionId];
        delete sessionStates[sessionId];
    });

    client.initialize();

    res.json({ 
        success: true, 
        sessionId: sessionId,
        message: 'Sessão iniciada. Use o endpoint /sessions/[id]/qr para obter QR Code'
    });
});

// 2. LISTAR SESSÕES
app.get('/sessions', (req, res) => {
    const sessionList = Object.keys(sessions).map(id => ({
        id: id,
        isAuthenticated: sessions[id].isAuthenticated,
        status: sessionStates[id]?.ready ? 'ready' : 'waiting_qr'
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
            message: 'Sessão já autenticada' 
        });
    }

    if (session.qrCode) {
        res.json({ 
            qrCode: session.qrCode,
            status: 'waiting_qr'
        });
    } else {
        // Aguardar QR Code por 30 segundos
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

// 4. REINICIAR SESSÃO
app.post('/sessions/:id/restore', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        sessions[sessionId].client.destroy();
        setTimeout(() => {
            sessions[sessionId].client.initialize();
            res.json({ success: true, message: 'Sessão reiniciada' });
        }, 1000);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. ENVIAR MENSAGEM DE TEXTO
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
        // Formatar número (remover caracteres especiais, adicionar @c.us)
        const formattedNumber = number.replace(/\D/g, '') + '@c.us';
        const client = sessions[sessionId].client;
        
        const result = await client.sendMessage(formattedNumber, message);
        
        res.json({ 
            success: true, 
            messageId: result.id._serialized,
            timestamp: result.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. ENVIAR IMAGEM/MÍDIA
app.post('/sessions/:id/send-media', async (req, res) => {
    const sessionId = req.params.id;
    const { number, base64Data, mimeType, caption, filename } = req.body;
    
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
        const formattedNumber = number.replace(/\D/g, '') + '@c.us';
        const client = sessions[sessionId].client;
        
        const media = new MessageMedia(mimeType, base64Data, filename);
        const result = await client.sendMessage(formattedNumber, media, { caption: caption });
        
        res.json({ 
            success: true, 
            messageId: result.id._serialized,
            timestamp: result.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. RECEBER MENSAGENS (HISTÓRICO)
app.get('/sessions/:id/messages', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    res.json({
        success: true,
        count: sessions[sessionId].messages.length,
        messages: sessions[sessionId].messages
    });
});

// 8. STATUS DA SESSÃO
app.get('/sessions/:id/status', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    res.json({
        isAuthenticated: sessions[sessionId].isAuthenticated,
        qrAvailable: !!sessions[sessionId].qrCode,
        messageCount: sessions[sessionId].messages.length,
        status: sessionStates[sessionId]?.ready ? 'ready' : 'waiting_qr'
    });
});

// 9. DESTRUIR SESSÃO
app.delete('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        await sessions[sessionId].client.destroy();
        delete sessions[sessionId];
        delete sessionStates[sessionId];
        saveSessions();
        
        res.json({ success: true, message: 'Sessão destruída' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para obter sessões em base64 (para backup)
app.get('/backup-sessions', (req, res) => {
    const sessionsBase64 = Buffer.from(JSON.stringify(sessions)).toString('base64');
    res.json({ sessions: sessionsBase64 });
});

// Endpoint para restaurar sessões do backup
app.post('/restore-sessions', (req, res) => {
    const { sessionsBase64 } = req.body;
    
    if (!sessionsBase64) {
        return res.status(400).json({ error: 'sessionsBase64 é obrigatório' });
    }

    try {
        sessions = JSON.parse(Buffer.from(sessionsBase64, 'base64').toString());
        res.json({ success: true, message: 'Sessões restauradas' });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao restaurar sessões' });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        sessions: Object.keys(sessions).length,
        endpoints: [
            'POST /sessions/start',
            'GET /sessions',
            'GET /sessions/:id/qr',
            'POST /sessions/:id/restore',
            'POST /sessions/:id/send-message',
            'POST /sessions/:id/send-media',
            'GET /sessions/:id/messages',
            'GET /sessions/:id/status',
            'DELETE /sessions/:id'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`API WhatsApp rodando na porta ${PORT}`);
    console.log(`Sessões carregadas: ${Object.keys(sessions).length}`);
});