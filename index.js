// backend/index.js
const express = require('express');
const cors = require('cors');
const http = require('http');
// const nodemailer = require('nodemailer'); // --- REMOVED: Nodemailer is no longer needed
const dotenv = require('dotenv');
const fileUpload = require('express-fileupload');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise'); // Using mysql2/promise for async/await
const { Server } = require('socket.io');

dotenv.config(); // Load environment variables from .env file for local development

const app = express();
const twilio = require('twilio'); // <--- Import Twilio library

// Removed 'const router = express.Router();' from here
// as we'll apply the route directly to 'app' or use a dedicated router file later if needed.

// Your Twilio credentials from .env
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g., 'whatsapp:+14155238886' for sandbox

const twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); // <--- Initialize Twilio client

// Backend API URL (if needed for internal backend calls, otherwise remove)
// This is usually a frontend concern, but can be used for internal backend-to-backend communication
const BACKEND_API_URL = process.env.REACT_APP_BACKEND_API_URL || 'https://schoolmeetingbackend-production-b8a8.up.railway.app';


// --- Configuration Variables from Environment ---
const PORT = process.env.PORT || 3001;
const FE_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:3000';
const SOCKET_IO_ORIGIN = process.env.SOCKET_IO_ORIGIN || 'http://localhost:3000';

// --- HTTP Server Setup ---
const server = http.createServer(app);

// --- Socket.IO Server Setup ---
const io = new Server(server, {
    cors: {
        origin: SOCKET_IO_ORIGIN,
        methods: ["GET", "POST"]
    }
});

// --- Database Pool Configuration ---
const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test Database Connection on Application Startup
pool.getConnection()
    .then(connection => {
        console.log('Successfully connected to Railway MySQL database!');
        connection.release();
    })
    .catch(err => {
        console.error('Failed to connect to Railway MySQL database:', err.message);
        console.error('Please check your MYSQL_* environment variables in Railway.');
    });

// --- Express Middleware ---
app.use(cors({
    origin: FE_ORIGIN,
    credentials: true
}));
app.use(express.json()); // Essential for parsing JSON bodies from frontend
app.use(bodyParser.urlencoded({ extended: true }));
app.use(fileUpload());
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_fallback_secret_for_dev_only_replace_in_prod',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'Lax'
    }
}));

// --- In-Memory Storage for Meeting Data (Temporary - Migrate to DB!) ---
// WARNING: This data will be lost on every server restart/redeploy.
// For production, you MUST store this data in your MySQL database.
// Updated comment to reflect recipientPhoneNumber
const meetingData = {}; // { meetingId: { id, createdAt, recipientPhoneNumber, expires, slotTime, status } }

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`Socket Connected: ${socket.id}`);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        socket.to(roomId).emit('user-joined', socket.id);
    });

    socket.on('send-call', ({ userToSignal, callerId, signal }) => {
        console.log(`Sending call signal from ${callerId} to ${userToSignal}`);
        io.to(userToSignal).emit('receive-call', { callerId, signal });
    });

    socket.on('accept-call', ({ callerId, signal }) => {
        console.log(`Accepting call signal from ${socket.id} to ${callerId}`);
        io.to(callerId).emit('call-accepted', { signal, id: socket.id });
    });

    socket.on('disconnect', () => {
        console.log(`Socket Disconnected: ${socket.id}`);
    });
});

// --- Helper Functions ---
const generateMeetingId = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    if (meetingData[result]) {
        return generateMeetingId();
    }
    return result;
};

// --- API Endpoints ---

// New endpoint to send WhatsApp invitation via Twilio (Moved inside app.post)
// --- IMPORTANT: This directly registers the route with 'app' ---
app.post('/send-whatsapp-invite-twilio', async (req, res) => {
    const { recipientPhoneNumber, meetingLink, meetingId, expirationTime } = req.body;

    if (!recipientPhoneNumber || !meetingLink || !meetingId || !expirationTime) {
        return res.status(400).json({ success: false, message: 'Missing required fields for WhatsApp invitation.' });
    }

    // Ensure phone number is in E.164 format for Twilio
    const formattedRecipientPhoneNumber = recipientPhoneNumber.startsWith('+') ? recipientPhoneNumber : `+${recipientPhoneNumber}`;

    try {
        // Using a WhatsApp Message Template (mandatory for business-initiated messages)
        // You MUST have this template approved in Twilio/Meta.
        // Twilio will map this to the appropriate Meta API call.
        const messageBody = `You've been invited to a meeting!\n\nClick here to join: ${meetingLink}\n\nMeeting ID: ${meetingId}\n\nThis invitation link will expire in ${expirationTime}.`;

        // For simplicity and quick testing in sandbox, we can use a free-form message
        // IF the recipient has recently messaged you or you're in Twilio Sandbox.
        // For production, outside a 24-hour window, TEMPLATES ARE MANDATORY.
        // For sandbox, you can often send free-form messages to joined numbers.

        const message = await twilioClient.messages.create({
            from: TWILIO_WHATSAPP_NUMBER, // Your Twilio WhatsApp number (e.g., 'whatsapp:+14155238886')
            to: `whatsapp:${formattedRecipientPhoneNumber}`, // Recipient's number
            body: messageBody // The message content (use a template for production/non-session messages)
        });


        console.log('Twilio WhatsApp message sent:', message.sid);
        res.status(200).json({ success: true, message: 'WhatsApp invitation sent successfully!', sid: message.sid });

    } catch (error) {
        console.error('Error sending WhatsApp message via Twilio:', error);
        res.status(500).json({ success: false, message: 'Failed to send WhatsApp invitation via Twilio.', error: error.message });
    }
});


// API Endpoint: Create a new meeting (MODIFIED FOR WHATSAPP LINK GENERATION)
app.post('/create-meeting', async (req, res) => {
    const { recipientPhoneNumber } = req.body; // CHANGED: Expect recipientPhoneNumber
    if (!recipientPhoneNumber) {
        return res.status(400).json({ success: false, message: 'Recipient phone number is required.' });
    }

    const meetingId = generateMeetingId();
    const expires = Date.now() + 30 * 60 * 1000;
    const meetingLink = `${FE_ORIGIN}/schedule/${meetingId}`;

    // Store meeting details in memory (REMINDER: MOVE TO DB)
    meetingData[meetingId] = {
        id: meetingId,
        createdAt: Date.now(),
        recipientPhoneNumber, // CHANGED: Store phone number
        expires,
        slotTime: null,
        status: 'pending'
    };

    try {
        console.log(`Meeting ID ${meetingId} created. Link: ${meetingLink} for phone number ${recipientPhoneNumber}`);
        res.json({ success: true, meetingId, expires, meetingLink, recipientPhoneNumber });
    } catch (err) {
        console.error('Error creating meeting:', err);
        res.status(500).json({ success: false, code: 'MEETING_CREATION_FAILED', message: 'Failed to create meeting.' });
    }
});

// API Endpoint: Select a 30-minute slot for a meeting
app.post('/select-slot', async (req, res) => {
    const { meetingId, slotTime } = req.body;
    if (!meetingId || !slotTime) {
        return res.status(400).json({ success: false, message: 'Meeting ID and slot time are required.' });
    }

    const meeting = meetingData[meetingId];
    if (!meeting) {
        return res.status(404).json({ success: false, message: 'Meeting not found.' });
    }

    if (!/^\d{2}:\d{2}$/.test(slotTime)) {
        return res.status(400).json({ success: false, message: 'Invalid slot time format. Expected HH:MM.' });
    }

    meeting.slotTime = slotTime;
    meeting.status = 'confirmed';
    console.log(`Slot ${slotTime} confirmed for meeting ID ${meetingId}`);
    res.json({ success: true, message: 'Slot confirmed successfully.' });
});

// API Endpoint: Validate a meeting ID and retrieve its status/slot time
app.get('/validate-meeting/:meetingId', (req, res) => {
    const meeting = meetingData[req.params.meetingId];
    if (!meeting) {
        return res.json({ valid: false, message: 'Meeting not found.' });
    }
    if (Date.now() > meeting.expires) {
        return res.json({ valid: false, message: 'This meeting invitation link has expired.' });
    }
    res.json({ valid: true, meetingId: meeting.id, slotTime: meeting.slotTime });
});

// API Endpoint: Get all school records
app.get('/api/schools', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.execute(
            'SELECT id, school_name, email, display_name, address, phone_number, student_count, contact_person FROM users'
        );
        res.json(rows);
    } catch (err) {
        console.error('Failed to fetch schools from database:', err);
        res.status(500).send('Failed to fetch schools due to a server error.');
    } finally {
        if (connection) connection.release();
    }
});

// --- Start the API and Socket.IO Server ---
server.listen(PORT, () => {
    console.log(`Backend API & Socket.IO Server listening on port ${PORT}`);
    console.log(`Frontend Origin configured: ${FE_ORIGIN}`);
    console.log(`Socket.IO Origin configured: ${SOCKET_IO_ORIGIN}`);
    console.log(`Database connected to: ${process.env.MYSQLHOST}/${process.env.MYSQLDATABASE}`);
});