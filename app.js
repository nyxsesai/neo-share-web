let ws = null;
let pc = null;
let localStream = null;
let shouldReconnect = false;
let keepAliveInterval = null;
let currentStep = 1;
let isAuthenticated = false;
let currentPin = null;

const serverUrlInput = document.getElementById('serverUrl');
const pinInput = document.getElementById('pinInput');
const connectBtn = document.getElementById('connectBtn');
const authenticateBtn = document.getElementById('authenticateBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const preview = document.querySelector('.preview');

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ===== PIN RESOLUTION FUNCTIONS =====
function resolvePin(pin) {
  if (typeof pin !== 'string') throw new Error('Pin must be a string');
  const s = pin.trim();
  if (!/^[0-9A-Fa-f]{8}$/.test(s) && !/^[0-9A-Fa-f]{10}$/.test(s)) {
    throw new Error('Invalid pin format — expected 8 or 10 hex characters.');
  }

  if (s.length === 8) {
    // simple case: 8 hex chars -> direct IP
    const intVal = parseInt(s, 16) >>> 0;
    const a = (intVal >>> 24) & 0xFF;
    const b = (intVal >>> 16) & 0xFF;
    const c = (intVal >>> 8) & 0xFF;
    const d = intVal & 0xFF;
    validateOctets([a, b, c, d]);
    return `${a}.${b}.${c}.${d}`;
  } else {
    // 10 hex chars: last 2 hex are salt
    const dataHex = s.slice(0, 8);
    const saltHex = s.slice(8);
    const intVal = parseInt(dataHex, 16) >>> 0;
    const salt = parseInt(saltHex, 16) & 0xFF;
    const a = (((intVal >>> 24) & 0xFF) ^ salt) & 0xFF;
    const b = (((intVal >>> 16) & 0xFF) ^ salt) & 0xFF;
    const c = (((intVal >>> 8) & 0xFF) ^ salt) & 0xFF;
    const d = ((intVal & 0xFF) ^ salt) & 0xFF;
    validateOctets([a, b, c, d]);
    return `${a}.${b}.${c}.${d}`;
  }
}

function validateOctets(arr) {
  if (!Array.isArray(arr) || arr.length !== 4) throw new Error('Invalid octets');
  for (const x of arr) {
    if (!Number.isInteger(x) || x < 0 || x > 255) {
      throw new Error('Decoded octet out of range: ' + x);
    }
  }
}

function updateStatus(text, state) {
    status.textContent = text;
    status.className = 'status ' + state;
}

function showStep(step) {
    // Hide all steps
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.step-dot').forEach(d => d.classList.remove('active'));
    
    // Show current step
    document.getElementById('step' + step).classList.add('active');
    document.getElementById('dot' + step).classList.add('active');
    currentStep = step;
}

// Automated connection and authentication with hex pin
function connectWithPin() {
    const hexPin = pinInput.value.trim();
    if (!hexPin) {
        updateStatus('Please enter hex PIN (8 or 10 characters)', 'disconnected');
        return;
    }

    try {
        // Resolve IP from hex pin
        const ip = resolvePin(hexPin);
        const serverUrl = `${ip}:8080`;
        
        console.log('Resolved IP from pin:', ip);
        updateStatus(`Resolved IP: ${ip} - Connecting...`, 'connecting');
        
        // Store pin for authentication
        currentPin = hexPin;
        
        // Connect to WebSocket
        const wsUrl = `ws://${serverUrl}/ws`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connected to', serverUrl);
            updateStatus('Connected - Authenticating...', 'connecting');
            shouldReconnect = true;
            
            // Send keep-alive ping every 3 seconds
            if (keepAliveInterval) clearInterval(keepAliveInterval);
            keepAliveInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 3000);
            
            // Automatically authenticate with the pin
            setTimeout(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'auth',
                        pin: currentPin
                    }));
                }
            }, 100);
        };

        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            console.log('Received:', message);

            if (message.type === 'auth_success') {
                isAuthenticated = true;
                updateStatus('Authenticated - Ready to cast', 'authenticated');
                showStep(3);
            } else if (message.type === 'auth_failed') {
                updateStatus('Authentication Failed: ' + (message.message || 'Invalid PIN'), 'disconnected');
                pinInput.value = '';
                pinInput.focus();
                showStep(1);
            } else if (message.type === 'error') {
                console.error('Server error:', message.message);
                updateStatus('Server error: ' + message.message, 'disconnected');
            } else if (message.type === 'answer' && isAuthenticated) {
                await pc.setRemoteDescription(new RTCSessionDescription(message));
            } else if (message.type === 'candidate' && isAuthenticated) {
                await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            updateStatus('Connection error - Check PIN or network', 'disconnected');
        };

        ws.onclose = () => {
            console.log('WebSocket closed');
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            updateStatus('Disconnected', 'disconnected');
            isAuthenticated = false;
            if (shouldReconnect && currentStep > 1) {
                setTimeout(() => {
                    if (shouldReconnect && (!ws || ws.readyState === WebSocket.CLOSED)) {
                        console.log('Attempting to reconnect...');
                        connectWithPin();
                    }
                }, 2000);
            }
        };
    } catch (error) {
        console.error('Pin resolution error:', error);
        updateStatus('Invalid PIN: ' + error.message, 'disconnected');
        pinInput.value = '';
        pinInput.focus();
    }
}

// Legacy function - no longer needed as authentication is automated
function authenticateWithPIN() {
    // Authentication is now handled automatically in connectWithPin()
    console.log('Authentication is handled automatically');
}

async function startCasting() {
    if (!isAuthenticated) {
        updateStatus('Please authenticate first', 'disconnected');
        return;
    }

    try {
        updateStatus('Starting screen capture...', 'connecting');

        // Capture screen with system audio
        // IMPORTANT: User must check "Share audio" or "Share tab audio" in browser dialog
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: { 
                cursor: 'always',
                displaySurface: 'monitor'
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
                channelCount: 2
            },
            preferCurrentTab: false,
            systemAudio: 'include'  // Request system audio explicitly
        });

        console.log('Captured tracks:', localStream.getTracks().map(t => t.kind + ': ' + t.label));
        
        // Check if audio was captured
        const hasAudio = localStream.getAudioTracks().length > 0;
        console.log('Has audio tracks:', hasAudio);
        
        // Check if it's system audio or just tab audio
        if (hasAudio) {
            const audioTrack = localStream.getAudioTracks()[0];
            console.log('Audio track label:', audioTrack.label);
            console.log('Audio track settings:', audioTrack.getSettings());
        } else {
            console.warn('⚠️ No system audio captured - User may have declined audio sharing');
            updateStatus('⚠️ No audio captured - Enable "Share audio" in dialog', 'connecting');
        }

        localVideo.srcObject = localStream;
        preview.style.display = 'block';

        // Create peer connection
        pc = new RTCPeerConnection(config);

        // Add tracks to peer connection
        localStream.getTracks().forEach(track => {
            console.log('Adding track to peer connection:', track.kind, track.label, 'enabled:', track.enabled);
            const sender = pc.addTrack(track, localStream);
            console.log('Track added, sender:', sender);
        });

        console.log('Total tracks in stream:', localStream.getTracks().length);
        console.log('Video tracks:', localStream.getVideoTracks().length);
        console.log('Audio tracks:', localStream.getAudioTracks().length);

        // ICE candidate handling
        pc.onicecandidate = (event) => {
            if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'candidate',
                    candidate: event.candidate
                }));
            }
        };

        // Connection state changes
        pc.onconnectionstatechange = () => {
            console.log('Connection state:', pc.connectionState);
            if (pc.connectionState === 'connected') {
                updateStatus('Casting to Android...', 'authenticated');
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                updateStatus('Connection lost', 'disconnected');
            }
        };

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'offer',
                sdp: offer.sdp
            }));
        }

        startBtn.disabled = true;
        stopBtn.disabled = false;
        updateStatus('Casting...', 'authenticated');

    } catch (error) {
        console.error('Error starting cast:', error);
        updateStatus('Failed to start casting: ' + error.message, 'disconnected');
        stopCasting();
    }
}

function stopCasting() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (pc) {
        pc.close();
        pc = null;
    }
    preview.style.display = 'none';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (ws && ws.readyState === WebSocket.OPEN && isAuthenticated) {
        updateStatus('Authenticated - Ready to cast', 'authenticated');
    } else {
        updateStatus('Disconnected', 'disconnected');
    }
}

window.addEventListener('beforeunload', () => {
    shouldReconnect = false;
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (ws) {
        ws.close();
        ws = null;
    }
});

// Event Listeners
connectBtn.addEventListener('click', connectWithPin);

authenticateBtn.addEventListener('click', connectWithPin);

pinInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        connectWithPin();
    }
    // Allow hex characters (0-9, A-F, a-f)
    if (!/[0-9A-Fa-f]/.test(e.key)) {
        e.preventDefault();
    }
});

serverUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        connectWithPin();
    }
});

startBtn.addEventListener('click', startCasting);
stopBtn.addEventListener('click', stopCasting);
