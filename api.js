const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cors());
const PORT = process.env.PORT || 3000;

// Configuração para Render Free (sem Chrome)
const { default: makeWASocket } = require('@whiskeysockets/baileys');

// Armazenamento em memória
let sessions = {};

// Criar pasta para sessões
const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Solução SIMPLES: Use uma API externa de WhatsApp
// Opção 1: whatsapp-web.js com puppeteer-extra e stealth
// Opção 2: API gratuita externa (mais confiável para Render Free)

// Vamos implementar uma solução híbrida
async function startWhatsAppSession(sessionId) {
    try {
        console.log(`Tentando conectar sessão ${sessionId}...`);
        
        // Tentativa com whatsapp-web.js (pode falhar no Render Free)
        const client = new Client({
            authStrategy: new LocalAuth({ clientId: sessionId }),
            puppeteer: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
                headless: 'new',
                executablePath: process.env.CHROMIUM_PATH || null
            }
        });

        sessions[sessionId] = {
            client: client,
            qrCode: null,
            isAuthenticated: false,
            messages: [],
            connected: false
        };

        client.on('qr', async (qr) => {
            console.log(`QR recebido para ${sessionId}`);
            sessions[sessionId].qrCode = await qrcode.toDataURL(qr);
            sessions[sessionId].qrRaw = qr;
        });

        client.on('ready', () => {
            console.log(`Client ${sessionId} está pronto!`);
            sessions[sessionId].isAuthenticated = true;
            sessions[sessionId].connected = true;
            sessions[sessionId].qrCode = null;
        });

        client.on('authenticated', () => {
            console.log(`Autenticado: ${sessionId}`);
            sessions[sessionId].isAuthenticated = true;
        });

        client.on('message', async (msg) => {
            console.log(`Mensagem recebida em ${sessionId}:`, msg.body);
            
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

            if (!sessions[sessionId].messages) {
                sessions[sessionId].messages = [];
            }
            
            sessions[sessionId].messages.push(messageData);
            
            if (sessions[sessionId].messages.length > 100) {
                sessions[sessionId].messages = sessions[sessionId].messages.slice(-100);
            }
        });

        client.on('disconnected', (reason) => {
            console.log(`Client ${sessionId} desconectado:`, reason);
            sessions[sessionId].connected = false;
            sessions[sessionId].isAuthenticated = false;
            
            // Tentar reconectar após 5 segundos
            setTimeout(() => {
                if (sessions[sessionId]) {
                    console.log(`Tentando reconectar ${sessionId}...`);
                    client.initialize();
                }
            }, 5000);
        });

        // Inicializar cliente
        await client.initialize();
        
        return client;
        
    } catch (error) {
        console.error(`Erro ao iniciar sessão ${sessionId}:`, error.message);
        
        // Se falhar, criar uma sessão simulada para testes
        sessions[sessionId] = {
            client: null,
            qrCode: null,
            isAuthenticated: false,
            messages: [],
            connected: false,
            simulated: true  // Flag para sessão simulada
        };
        
        // Gerar QR Code simulado para testes
        const testQR = `2@${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
        sessions[sessionId].qrCode = await qrcode.toDataURL(testQR);
        sessions[sessionId].qrRaw = testQR;
        
        // Simular autenticação após 30 segundos
        setTimeout(() => {
            if (sessions[sessionId] && sessions[sessionId].simulated) {
                sessions[sessionId].isAuthenticated = true;
                sessions[sessionId].connected = true;
                console.log(`Sessão simulada ${sessionId} "autenticada" para testes`);
            }
        }, 30000);
        
        return null;
    }
}

// 1. INICIAR SESSÃO
app.post('/sessions/start', async (req, res) => {
    try {
        const sessionId = req.body.sessionId || `session_${Date.now()}`;
        
        if (sessions[sessionId]) {
            return res.json({ 
                success: true, 
                sessionId: sessionId,
                message: 'Sessão já existe',
                existing: true
            });
        }

        await startWhatsAppSession(sessionId);

        res.json({ 
            success: true, 
            sessionId: sessionId,
            message: 'Sessão iniciada. Use /sessions/[id]/qr para obter QR Code',
            note: 'No Render Free, o WhatsApp pode ter funcionalidade limitada'
        });
    } catch (error) {
        console.error('Erro em /sessions/start:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            note: 'Para uso completo, considere um servidor com suporte a Chrome'
        });
    }
});

// 2. LISTAR SESSÕES
app.get('/sessions', (req, res) => {
    const sessionList = Object.keys(sessions).map(id => ({
        id: id,
        isAuthenticated: sessions[id].isAuthenticated,
        connected: sessions[id].connected || false,
        simulated: sessions[id].simulated || false,
        messageCount: sessions[id].messages?.length || 0,
        status: sessions[id].isAuthenticated ? 'authenticated' : 
                sessions[id].qrCode ? 'waiting_qr' : 'connecting'
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
            simulated: session.simulated || false
        });
    }

    if (session.qrCode) {
        res.json({ 
            qrCode: session.qrCode,
            status: 'waiting_qr',
            simulated: session.simulated || false
        });
    } else {
        // Aguardar QR Code por 30 segundos
        let attempts = 0;
        const checkQR = setInterval(() => {
            if (session.qrCode) {
                clearInterval(checkQR);
                res.json({ 
                    qrCode: session.qrCode,
                    status: 'waiting_qr',
                    simulated: session.simulated || false
                });
            }
            attempts++;
            if (attempts > 30) {
                clearInterval(checkQR);
                res.json({ 
                    status: 'generating',
                    message: 'Gerando QR Code... tente novamente em 5 segundos',
                    simulated: session.simulated || false
                });
            }
        }, 1000);
    }
});

// 4. ENVIAR MENSAGEM (Simulado no Render Free)
app.post('/sessions/:id/send-message', async (req, res) => {
    const sessionId = req.params.id;
    const { number, message } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    if (!number || !message) {
        return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
    }

    // Verificar se é sessão simulada
    if (sessions[sessionId].simulated) {
        return res.json({ 
            success: true, 
            messageId: `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            note: 'Mensagem simulada (Render Free não suporta WhatsApp real)',
            warning: 'Para mensagens reais, use um servidor com Chrome/VPS'
        });
    }

    if (!sessions[sessionId].isAuthenticated) {
        return res.status(400).json({ error: 'Sessão não autenticada' });
    }

    try {
        const client = sessions[sessionId].client;
        if (!client) {
            throw new Error('Cliente não disponível');
        }
        
        const formattedNumber = number.replace(/\D/g, '') + '@c.us';
        const result = await client.sendMessage(formattedNumber, message);
        
        res.json({ 
            success: true, 
            messageId: result.id._serialized,
            timestamp: result.timestamp
        });
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ 
            error: error.message,
            note: 'No Render Free, o envio real pode não funcionar',
            alternative: 'Use a sessão simulada para testes'
        });
    }
});

// 5. ENVIAR IMAGEM (Simulado no Render Free)
app.post('/sessions/:id/send-media', async (req, res) => {
    const sessionId = req.params.id;
    const { number, base64Data, mimeType, caption, filename } = req.body;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    if (!number || !base64Data || !mimeType) {
        return res.status(400).json({ 
            error: 'Número, base64Data e mimeType são obrigatórios' 
        });
    }

    // Verificar se é sessão simulada
    if (sessions[sessionId].simulated) {
        return res.json({ 
            success: true, 
            messageId: `media_sim_${Date.now()}`,
            timestamp: Date.now(),
            note: 'Mídia simulada (Render Free não suporta envio real)',
            warning: 'Para mídia real, use um servidor com Chrome/VPS'
        });
    }

    if (!sessions[sessionId].isAuthenticated) {
        return res.status(400).json({ error: 'Sessão não autenticada' });
    }

    res.status(501).json({ 
        error: 'Envio de mídia não suportado no Render Free',
        suggestion: 'Use um servidor com Chrome (VPS, Railway, Heroku Paid, etc.)'
    });
});

// 6. RECEBER MENSAGENS
app.get('/sessions/:id/messages', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    // Se for sessão simulada, adicionar algumas mensagens de exemplo
    if (sessions[sessionId].simulated && (!sessions[sessionId].messages || sessions[sessionId].messages.length === 0)) {
        sessions[sessionId].messages = [
            {
                id: 'sim_1',
                from: '5511999999999@c.us',
                to: 'me',
                body: 'Esta é uma mensagem simulada para testes',
                timestamp: Date.now() - 3600000,
                hasMedia: false,
                type: 'chat'
            },
            {
                id: 'sim_2',
                from: '5511888888888@c.us',
                to: 'me',
                body: 'No Render Free, as mensagens são simuladas',
                timestamp: Date.now() - 1800000,
                hasMedia: false,
                type: 'chat'
            }
        ];
    }

    res.json({
        success: true,
        simulated: sessions[sessionId].simulated || false,
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
        connected: sessions[sessionId].connected || false,
        qrAvailable: !!sessions[sessionId].qrCode,
        messageCount: sessions[sessionId].messages?.length || 0,
        simulated: sessions[sessionId].simulated || false,
        status: sessions[sessionId].isAuthenticated ? 'authenticated' : 
                sessions[sessionId].qrCode ? 'waiting_qr' : 'connecting',
        note: sessions[sessionId].simulated ? 
              'Sessão simulada para testes no Render Free' : 
              'Sessão real (pode não funcionar no Render Free)'
    });
});

// 8. REINICIAR SESSÃO
app.post('/sessions/:id/restore', (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        // Resetar sessão
        sessions[sessionId].isAuthenticated = false;
        sessions[sessionId].qrCode = null;
        sessions[sessionId].connected = false;
        
        // Se tiver cliente, tentar reiniciar
        if (sessions[sessionId].client) {
            sessions[sessionId].client.destroy();
            setTimeout(() => {
                sessions[sessionId].client.initialize();
            }, 1000);
        }
        
        res.json({ 
            success: true, 
            message: 'Sessão reiniciada',
            simulated: sessions[sessionId].simulated || false
        });
    } catch (error) {
        res.status(500).json({ 
            error: error.message,
            simulated: sessions[sessionId].simulated || false
        });
    }
});

// 9. DESTRUIR SESSÃO
app.delete('/sessions/:id', async (req, res) => {
    const sessionId = req.params.id;
    
    if (!sessions[sessionId]) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
    }

    try {
        if (sessions[sessionId].client) {
            await sessions[sessionId].client.destroy();
        }
        
        delete sessions[sessionId];
        res.json({ success: true, message: 'Sessão destruída' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 10. INFORMAÇÕES DO SISTEMA
app.get('/system/info', (req, res) => {
    res.json({
        platform: 'Render Free',
        limitation: 'Não suporta Chrome/Puppeteer',
        suggestion: 'Para WhatsApp completo, use:',
        alternatives: [
            '1. Railway.app (tem plano free com Chrome)',
            '2. Heroku com buildpack: https://github.com/jontewks/puppeteer-heroku-buildpack',
            '3. VPS barato (DigitalOcean, Vultr, etc.)',
            '4. Replit (com configuração especial)'
        ],
        current_sessions: Object.keys(sessions).length,
        simulated_sessions: Object.keys(sessions).filter(id => sessions[id].simulated).length
    });
});

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        platform: 'Render Free',
        warning: 'WhatsApp real pode não funcionar (sem Chrome)',
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
            'DELETE /sessions/:id',
            'GET /system/info'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`WhatsApp API (Render Free) rodando na porta ${PORT}`);
    console.log(`⚠️  ATENÇÃO: Render Free não suporta Chrome/Puppeteer`);
    console.log(`📱 Sessões serão simuladas para testes`);
});