// backend/index.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const fileUpload = require('express-fileupload'); // Keep this middleware for now, even if specific upload route is removed
const session = require('express-session');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise'); // Using mysql2/promise for async/await
const { Server } = require('socket.io');

dotenv.config(); // Load environment variables from .env file

const app = express();
const server = http.createServer(app); // Create HTTP server for Socket.IO
const io = new Server(server, {
  cors: {
    origin: ["http://192.168.1.22:3000"], // Allow requests from your React app's origin
    methods: ["GET", "POST"]
  }
});

// Database Pool Configuration
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'kali',
  database: process.env.DB_DATABASE || 'schooldb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Middleware
app.use(cors({
  origin: 'http://192.168.1.22:3000', // Specify your frontend origin for CORS
  credentials: true // If you're using cookies/sessions later
}));
app.use(express.json()); // For parsing application/json
app.use(bodyParser.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(fileUpload()); // For handling file uploads (middleware still active, but specific route removed)
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecretkey', // Use a strong secret in production
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Nodemailer Transporter Configuration
const transporter = nodemailer.createTransport({
  service: 'gmail', // Or your email service provider
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// In-memory storage for meeting data (for simplicity, consider a database for production)
const meetingData = {}; // { meetingId: { id, createdAt, recipientEmail, expires, slotTime, status } }

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // Event for a user joining a specific room
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
    // Notify other users in the room that a new user has joined
    socket.to(roomId).emit('user-joined', socket.id);
  });

  // Event for sending WebRTC signaling data (offer)
  socket.on('send-call', ({ userToSignal, callerId, signal }) => {
    console.log(`Sending call signal from ${callerId} to ${userToSignal}`);
    // Forward the signal to the intended recipient
    io.to(userToSignal).emit('receive-call', { callerId, signal });
  });

  // Event for accepting WebRTC signaling data (answer)
  socket.on('accept-call', ({ callerId, signal }) => {
    console.log(`Accepting call signal from ${socket.id} to ${callerId}`);
    // Forward the acceptance signal back to the caller
    io.to(callerId).emit('call-accepted', { signal, id: socket.id });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Socket Disconnected: ${socket.id}`);
    // In a more complex app, you might want to notify rooms about user departure
  });
});

// Helper function to generate a unique meeting ID
const generateMeetingId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  // Ensure the generated ID is unique in our in-memory storage
  if (meetingData[result]) {
    return generateMeetingId(); // Recurse if ID already exists
  }
  return result;
};

// API Endpoint: Create a new meeting
app.post('/create-meeting', async (req, res) => {
  const { recipientEmail } = req.body;
  if (!recipientEmail) {
    return res.status(400).json({ success: false, message: 'Recipient email is required.' });
  }

  const meetingId = generateMeetingId();
  // Meeting link expiry set to 30 minutes from creation for the invitation link itself
  const expires = Date.now() + 30 * 60 * 1000;
  // The meeting link will point to the frontend's schedule route
  const meetingLink = `http://192.168.1.22:3000/schedule/${meetingId}`;

  // Store meeting details in memory
  meetingData[meetingId] = {
    id: meetingId,
    createdAt: Date.now(),
    recipientEmail,
    expires, // Expiry for the invitation link
    slotTime: null, // No slot time selected initially
    status: 'pending' // Meeting status
  };

  try {
    // Send meeting invitation email
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

  // Basic validation for slotTime format (HH:MM)
  if (!/^\d{2}:\d{2}$/.test(slotTime)) {
      return res.status(400).json({ success: false, message: 'Invalid slot time format. Expected HH:MM.' });
  }

  meeting.slotTime = slotTime; // Update the slot time
  meeting.status = 'confirmed'; // Update meeting status
  console.log(`Slot ${slotTime} confirmed for meeting ID ${meetingId}`);
  res.json({ success: true, message: 'Slot confirmed successfully.' });
});

// API Endpoint: Validate a meeting ID and retrieve its status/slot time
app.get('/validate-meeting/:meetingId', (req, res) => {
  const meeting = meetingData[req.params.meetingId];
  if (!meeting) {
    return res.json({ valid: false, message: 'Meeting not found.' });
  }
  // Check if the invitation link itself has expired (30 minutes from creation)
  if (Date.now() > meeting.expires) {
    return res.json({ valid: false, message: 'This meeting invitation link has expired.' });
  }
  // Return validity, meeting ID, and the confirmed slot time (if any)
  res.json({ valid: true, meetingId: meeting.id, slotTime: meeting.slotTime });
});

// REMOVED: API Endpoint: Upload a document for a school (as requested)
// This entire route handler has been removed to disable the upload functionality.
/*
app.post('/api/schools/:id/upload', async (req, res) => {
  const schoolId = req.params.id;
  if (!req.files || Object.keys(req.files).length === 0 || !req.files.document) {
    return res.status(400).send('No file uploaded.');
  }
  const file = req.files.document;
  let connection;
  try {
    connection = await pool.getConnection();
    const [result] = await connection.execute(
      'UPDATE users SET document = ?, has_document = TRUE WHERE id = ?',
      [file.data, schoolId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).send('School not found.');
    }
    res.send('Document uploaded successfully.');
  } catch (err) {
    console.error('Database error during file upload:', err);
    res.status(500).send('Failed to upload document due to a server error.');
  } finally {
    if (connection) connection.release();
  }
});
*/

// API Endpoint: Get all school records
app.get('/api/schools', async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    // UPDATED: Select all relevant columns, EXCLUDING 'num_teachers', 'document', and 'has_document'
    const [rows] = await connection.execute(
      'SELECT id, name, principal, school_name, address, phone_no, email, num_students FROM users'
    );
    res.json(rows);
  } catch (err) {
    console.error('Failed to fetch schools from database:', err);
    res.status(500).send('Failed to fetch schools due to a server error.');
  } finally {
    if (connection) connection.release();
  }
});

// Start the API server on port 3001
app.listen(3001, () => console.log('API Server: http://192.168.1.22:3001'));
// Start the Socket.IO server on port 3010
server.listen(3010, () => console.log('Socket.IO Server: http://192.168.1.22:3010'));
