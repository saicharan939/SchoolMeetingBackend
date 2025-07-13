// backend/index.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fileUpload = require('express-fileupload');
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise'); // Using mysql2/promise for async/await
const { Server } = require('socket.io');

dotenv.config(); // Load environment variables from .env file for local development

const app = express();

// --- Configuration Variables from Environment ---
// Railway injects a PORT variable. We use a fallback for local development.
const PORT = process.env.PORT || 3001;
// For Socket.IO, it's often run on the same HTTP server port.
// If you truly need a separate port for Socket.IO on Railway, you'd need a separate Railway service
// or specific configuration, which is more advanced. For now, assume it runs on the main PORT.
// If you explicitly set SOCKET_IO_PORT in Railway ENV and want to use it:
// const SOCKET_IO_PORT = process.env.SOCKET_IO_PORT || 3010;

// Frontend URL for CORS and meeting invitation links. This will be your Vercel URL.
const FE_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:3000';
// Socket.IO origin for CORS. Typically the same as FE_ORIGIN.
const SOCKET_IO_ORIGIN = process.env.SOCKET_IO_ORIGIN || 'http://localhost:3000';

// --- HTTP Server Setup ---
const server = http.createServer(app); // Create HTTP server to share with Express and Socket.IO

// --- Socket.IO Server Setup ---
const io = new Server(server, {
    cors: {
        origin: SOCKET_IO_ORIGIN, // Dynamic origin for Socket.IO
        methods: ["GET", "POST"]
    }
});

// --- Database Pool Configuration ---
// These environment variables will be provided by Railway's MySQL service directly to your backend service
const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE, // This should be 'railway' by default
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test Database Connection on Application Startup
pool.getConnection()
    .then(connection => {
        console.log('Successfully connected to Railway MySQL database!');
        connection.release(); // Release the connection back to the pool immediately
    })
    .catch(err => {
        console.error('Failed to connect to Railway MySQL database:', err.message);
        console.error('Please check your MYSQL_* environment variables in Railway.');
        // It's good practice to exit if database connection fails on startup in production
        // process.exit(1);
    });

// --- Express Middleware ---
app.use(cors({
    origin: FE_ORIGIN, // Dynamic origin for Express CORS
    credentials: true // Important if you're using cookies/sessions
}));
app.use(express.json()); // For parsing application/json bodies
app.use(bodyParser.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(fileUpload()); // Middleware for handling file uploads
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_fallback_secret_for_dev_only_replace_in_prod', // USE A VERY STRONG, RANDOM SECRET IN PRODUCTION
    resave: false, // Don't save session if unmodified
    saveUninitialized: true, // Save new sessions even if not modified
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true in production for HTTPS
        httpOnly: true, // Prevents client-side JavaScript from accessing cookies
        sameSite: 'Lax' // Helps protect against CSRF attacks. Can be 'None' for cross-site with secure:true
    }
}));

// --- Nodemailer Transporter Configuration ---
const transporter = nodemailer.createTransport({
    service: 'gmail', // Or your specific SMTP details
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- In-Memory Storage for Meeting Data (Temporary - Migrate to DB!) ---
// WARNING: This data will be lost on every server restart/redeploy.
// For production, you MUST store this data in your MySQL database.
const meetingData = {}; // { meetingId: { id, createdAt, recipientEmail, expires, slotTime, status } }

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`Socket Connected: ${socket.id}`);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        socket.to(roomId).emit('user-joined', socket.id); // Notify others in room
    });

    socket.on('send-call', ({ userToSignal, callerId, signal }) => {
        console.log(`Sending call signal from ${callerId} to ${userToSignal}`);
        io.to(userToSignal).emit('receive-call', { callerId, signal }); // Forward signal
    });

    socket.on('accept-call', ({ callerId, signal }) => {
        console.log(`Accepting call signal from ${socket.id} to ${callerId}`);
        io.to(callerId).emit('call-accepted', { signal, id: socket.id }); // Forward acceptance
    });

    socket.on('disconnect', () => {
        console.log(`Socket Disconnected: ${socket.id}`);
        // Consider notifying rooms about user departure here
    });
});

// --- Helper Functions ---
const generateMeetingId = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    // This uniqueness check is for in-memory storage only.
    // If using DB, you would query the DB for uniqueness.
    if (meetingData[result]) {
        return generateMeetingId(); // Recurse if ID already exists
    }
    return result;
};

// --- API Endpoints ---

// API Endpoint: Create a new meeting
app.post('/create-meeting', async (req, res) => {
    const { recipientEmail } = req.body;
    if (!recipientEmail) {
        return res.status(400).json({ success: false, message: 'Recipient email is required.' });
    }

    const meetingId = generateMeetingId();
    // Meeting link expiry (30 minutes from creation for the invitation link itself)
    const expires = Date.now() + 30 * 60 * 1000;
    // The meeting link will now use the dynamic FRONTEND_URL
    const meetingLink = `${FE_ORIGIN}/schedule/${meetingId}`;

    // Store meeting details in memory (REMINDER: MOVE TO DB)
    meetingData[meetingId] = {
        id: meetingId,
        createdAt: Date.now(),
        recipientEmail,
        expires,
        slotTime: null,
        status: 'pending'
    };

    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            subject: 'Meeting Invitation',
            html: `
                <p>You've been invited to a meeting. Click the link below to schedule your slot and join:</p>
                <p><a href="${meetingLink}">${meetingLink}</a></p>
                <p>This invitation link will expire in 30 minutes.</p>
            `
        });
        console.log(`Meeting ID ${meetingId} created for ${recipientEmail}. Link: ${meetingLink}`);
        res.json({ success: true, meetingId, expires, meetingLink });
    } catch (err) {
        console.error('Error sending email:', err);
        res.status(500).json({ success: false, code: 'EMAIL_FAILED', message: 'Failed to send meeting invitation email.' });
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
        // In your backend/index.js, find this line:
// app.get('/api/schools', async (req, res) => { ...

// And change the SQL query from:
// 'SELECT id, name, principal, school_name, address, phone_no, email, num_students FROM users'

// TO THIS:
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
// The main server listens on the PORT provided by Railway
server.listen(PORT, () => {
    console.log(`Backend API & Socket.IO Server listening on port ${PORT}`);
    console.log(`Frontend Origin configured: ${FE_ORIGIN}`);
    console.log(`Socket.IO Origin configured: ${SOCKET_IO_ORIGIN}`);
    console.log(`Database connected to: ${process.env.MYSQLHOST}/${process.env.MYSQLDATABASE}`);
});