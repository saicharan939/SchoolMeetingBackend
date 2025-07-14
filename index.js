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
app.use(express.json());
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

// --- Nodemailer Transporter Configuration (REMOVED) ---
// const transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: {
//         user: process.env.EMAIL_USER,
//         pass: process.env.EMAIL_PASS
//     }
// });

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
        // REMOVED: Email sending logic has been taken out
        console.log(`Meeting ID ${meetingId} created. Link: ${meetingLink} for phone number ${recipientPhoneNumber}`);
        // ADDED: Return recipientPhoneNumber in the response for frontend use
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