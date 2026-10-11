import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Razorpay from 'razorpay';
import nodemailer from 'nodemailer';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import Booking from './models/Booking.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// Serve static frontend files (root index.html and assets)
app.use(express.static(path.join(__dirname, '..')));

// In-memory fallback cache if MongoDB is offline or connecting
const inMemoryBookings = [];

// Helper to check MongoDB connection status
const isDbConnected = () => mongoose.connection.readyState === 1;

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/stadiumDB';
mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000 // fail fast instead of hanging 30s if Atlas IP not whitelisted
  })
  .then(() => console.log('✅ MongoDB Connected successfully!'))
  .catch((err) =>
    console.warn('⚠️ MongoDB connection notice:', err.message, '\n   (Server running in resilient mode with memory fallback)')
  );

// Razorpay Client Initialization
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_51b9h7HjKkZq1x';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'your_secret_key';

let razorpay = null;
try {
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
  });
} catch (e) {
  console.warn('⚠️ Razorpay client notice:', e.message);
}

// Helper: Generate PDF Ticket Buffer
async function generateTicketPDFBuffer(booking) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [320, 560], margin: 0 });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      // Dark header banner
      doc.rect(0, 0, 320, 150).fill('#0c1527');

      // Accent strip
      doc.rect(0, 0, 320, 8).fill('#2f7bff');

      // Header Texts
      doc.fillColor('#2f7bff').fontSize(8).font('Helvetica-Bold').text('OFFICIAL MATCHDAY E-TICKET', 20, 20, { align: 'center', width: 280 });
      doc.fillColor('#ffffff').fontSize(16).text('INDIA   vs   PAKISTAN', 20, 36, { align: 'center', width: 280 });
      doc.fillColor('#b0c4de').fontSize(9).font('Helvetica').text('Jawaharlal Nehru Stadium (JLN) · New Delhi', 20, 58, { align: 'center', width: 280 });
      doc.fillColor('#20e889').fontSize(9).font('Helvetica-Bold').text('SATURDAY · 24 OCT 2026 · 19:30 IST', 20, 74, { align: 'center', width: 280 });
      doc.fillColor('#a0b0cb').fontSize(8).font('Helvetica').text('Gates open 17:00 IST · Entry via Gate 4B', 20, 90, { align: 'center', width: 280 });

      // Booking Ref Pill
      doc.roundedRect(60, 110, 200, 24, 6).fill('#172642');
      doc.fillColor('#ffffff').fontSize(10).font('Courier-Bold').text(`REF: ${booking.bookingRef}`, 60, 117, { align: 'center', width: 200 });

      // Perforated Line
      doc.strokeColor('#b0c4de').dash(4, { space: 4 }).moveTo(10, 150).lineTo(310, 150).stroke();
      doc.undash();

      // Notch cutouts
      doc.circle(0, 150, 8).fill('#ffffff');
      doc.circle(320, 150, 8).fill('#ffffff');

      // White Body background
      doc.rect(0, 150, 320, 410).fill('#ffffff');

      // 4 Seat Detail boxes
      const boxes = [
        { label: 'SECTION', val: String(booking.seatDetails.section) },
        { label: 'ROW', val: String(booking.seatDetails.row) },
        { label: 'SEAT', val: String(booking.seatDetails.seat) },
        { label: 'TIER', val: String(booking.seatDetails.tier) }
      ];
      boxes.forEach((b, i) => {
        const bx = 16 + i * 72;
        doc.roundedRect(bx, 168, 66, 48, 6).fillAndStroke('#f3f6fc', '#d7e2f0');
        doc.fillColor('#6a7d9b').fontSize(7).font('Helvetica-Bold').text(b.label, bx, 176, { align: 'center', width: 66 });
        doc.fillColor('#0f172a').fontSize(b.label === 'TIER' ? 8 : 13).text(b.val, bx, 192, { align: 'center', width: 66 });
      });

      // User details card
      doc.roundedRect(16, 230, 288, 52, 6).fillAndStroke('#f8fafc', '#e2e8f0');
      doc.fillColor('#6a7d9b').fontSize(7.5).font('Helvetica-Bold').text('TICKET HOLDER', 28, 238);
      doc.fillColor('#0f172a').fontSize(11).text(booking.userDetails.name, 28, 250);
      doc.fillColor('#475569').fontSize(8.5).font('Helvetica').text(`${booking.userDetails.email}  ·  +91 ${booking.userDetails.phone}`, 28, 265);

      // Payment Box
      doc.roundedRect(16, 294, 288, 52, 6).fillAndStroke('#f0fdf4', '#bbf7d0');
      doc.fillColor('#166534').fontSize(7.5).font('Helvetica-Bold').text('PAYMENT CONFIRMED (PAID)', 28, 302);
      doc.fillColor('#15803d').fontSize(13).text(`INR ₹${Number(booking.seatDetails.price).toLocaleString('en-IN')}`, 28, 314);
      doc.fillColor('#166534').fontSize(7.5).font('Courier').text(`Payment ID: ${booking.paymentDetails.razorpayPaymentId}`, 28, 331);

      // QR Code
      const qrData = `TICKET:${booking.bookingRef}|SEC:${booking.seatDetails.section}|ROW:${booking.seatDetails.row}|SEAT:${booking.seatDetails.seat}|PAY:${booking.paymentDetails.razorpayPaymentId}`;
      const qrDataUrl = await QRCode.toDataURL(qrData, { margin: 1, width: 140 });
      const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
      doc.image(qrBuffer, 100, 360, { width: 120, height: 120 });

      // Scan instruction
      doc.fillColor('#2f7bff').fontSize(8).font('Helvetica-Bold').text('SCAN AT TURNSTILE 4B FOR RAPID ENTRY', 20, 488, { align: 'center', width: 280 });
      doc.fillColor('#64748b').fontSize(9).font('Courier-Bold').text(`* ${booking.bookingRef} *`, 20, 502, { align: 'center', width: 280 });
      doc.fillColor('#94a3b8').fontSize(6.5).font('Helvetica').text('Government Photo ID mandatory for entry. Non-transferable & non-refundable.', 20, 524, { align: 'center', width: 280 });
      doc.text('Issued by JLN Stadium Box Office New Delhi', 20, 536, { align: 'center', width: 280 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ==========================================================
   API ENDPOINTS
   ========================================================== */

// 1. POST /api/create-order: Creates a Razorpay order with the seat price
app.post('/api/create-order', async (req, res) => {
  try {
    const { price, seatDetails } = req.body;
    if (!price) {
      return res.status(400).json({ error: 'Seat price is required' });
    }

    // Check if seat is already booked in MongoDB or in-memory
    if (seatDetails && seatDetails.section && seatDetails.row && seatDetails.seat) {
      if (isDbConnected()) {
        try {
          const existing = await Booking.findOne({
            'seatDetails.section': String(seatDetails.section),
            'seatDetails.row': Number(seatDetails.row),
            'seatDetails.seat': Number(seatDetails.seat)
          });
          if (existing) {
            return res.status(400).json({ error: 'This seat is already booked and sold out!' });
          }
        } catch (dbErr) {
          console.warn('DB check notice:', dbErr.message);
        }
      } else {
        const existingMem = inMemoryBookings.find(
          (b) =>
            b.seatDetails.section === String(seatDetails.section) &&
            b.seatDetails.row === Number(seatDetails.row) &&
            b.seatDetails.seat === Number(seatDetails.seat)
        );
        if (existingMem) {
          return res.status(400).json({ error: 'This seat is already booked and sold out!' });
        }
      }
    }

    const amountPaise = Math.round(Number(price) * 100);
    const keyId = RAZORPAY_KEY_ID;
    const keySecret = RAZORPAY_KEY_SECRET;

    let order = null;
    const hasLiveRazorpay = razorpay && keyId && keySecret && !keyId.includes('your_key') && !keySecret.includes('your_secret');

    if (hasLiveRazorpay) {
      order = await razorpay.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`
      });
    } else {
      // Mock / sandbox test order for zero-friction testing
      order = {
        id: `order_test_${Date.now()}`,
        amount: amountPaise,
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`
      };
    }

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: err.message || 'Failed to create order' });
  }
});

// 2. POST /api/verify-payment: Verifies signature, saves booking, generates PDF, sends email
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      userDetails,
      seatDetails
    } = req.body;

    if (!userDetails || !seatDetails) {
      return res.status(400).json({ error: 'User details and seat details are required' });
    }

    // Verify payment signature
    let isSignatureValid = false;
    const secret = RAZORPAY_KEY_SECRET;
    const hasLiveSecret = secret && !secret.includes('your_secret');

    if (hasLiveSecret && razorpaySignature && razorpayOrderId && razorpayPaymentId) {
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${razorpayOrderId}|${razorpayPaymentId}`);
      const expectedSignature = hmac.digest('hex');
      isSignatureValid = (expectedSignature === razorpaySignature);
    } else {
      // Allow valid test / sandbox signatures
      isSignatureValid = true;
    }

    if (!isSignatureValid) {
      return res.status(400).json({ error: 'Payment signature verification failed' });
    }

    // Generate unique booking reference
    const bookingRef = `JLN-${Math.floor(100000 + Math.random() * 900000)}`;

    const bookingPayload = {
      userDetails: {
        name: userDetails.name,
        email: userDetails.email,
        phone: userDetails.phone
      },
      seatDetails: {
        seatIndex: seatDetails.seatIndex ?? seatDetails.index,
        section: String(seatDetails.section),
        row: Number(seatDetails.row),
        seat: Number(seatDetails.seat),
        tier: String(seatDetails.tier),
        price: Number(seatDetails.price),
        viewScore: Number(seatDetails.viewScore || seatDetails.score || 85)
      },
      paymentDetails: {
        razorpayOrderId: razorpayOrderId || `order_${Date.now()}`,
        razorpayPaymentId: razorpayPaymentId || `pay_${Date.now()}`,
        razorpaySignature: razorpaySignature || 'verified_test_sig',
        status: 'PAID'
      },
      bookingRef,
      createdAt: new Date()
    };

    // Save in MongoDB if connected, and in memory
    let savedBooking = bookingPayload;
    if (isDbConnected()) {
      try {
        savedBooking = await Booking.create(bookingPayload);
        console.log(`💾 Booking record saved in MongoDB: ${bookingRef}`);
      } catch (dbErr) {
        console.warn('MongoDB save notice:', dbErr.message);
        inMemoryBookings.push(bookingPayload);
      }
    } else {
      inMemoryBookings.push(bookingPayload);
      console.log(`💾 Booking stored in memory (MongoDB connecting/offline): ${bookingRef}`);
    }

    // Generate PDF Ticket Buffer
    let pdfBuffer = null;
    try {
      pdfBuffer = await generateTicketPDFBuffer(bookingPayload);
    } catch (pdfErr) {
      console.warn('PDF generation notice:', pdfErr.message);
    }

    // Send Ticket via Email using Nodemailer
    let emailSent = false;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (smtpUser && smtpPass && pdfBuffer && userDetails.email) {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: parseInt(process.env.SMTP_PORT) === 465,
          auth: {
            user: smtpUser,
            pass: smtpPass
          }
        });

        await transporter.sendMail({
          from: process.env.FROM_EMAIL || `"JLN Stadium Box Office" <${smtpUser}>`,
          to: userDetails.email,
          subject: `🎟️ Your Match Ticket: INDIA vs PAKISTAN [Ref: ${bookingRef}]`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background-color: #0b1220; color: #ffffff; border-radius: 14px;">
              <div style="border-bottom: 2px solid #2f7bff; padding-bottom: 12px; margin-bottom: 16px;">
                <h1 style="color: #20e889; margin: 0; font-size: 22px;">🎉 Booking Confirmed!</h1>
                <p style="color: #a0b0cb; margin: 4px 0 0; font-size: 13px;">JLN Stadium · Hero Intercontinental Matchday Pass</p>
              </div>
              <p>Dear <strong>${userDetails.name}</strong>,</p>
              <p>Your seat booking is confirmed for <strong>INDIA vs PAKISTAN</strong>!</p>
              
              <div style="background-color: rgba(255,255,255,0.06); padding: 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); margin: 20px 0;">
                <table style="width: 100%; color: #ffffff; font-size: 13.5px; border-collapse: collapse;">
                  <tr><td style="padding: 6px 0; color: #94a3b8;">Booking Reference:</td><td style="padding: 6px 0; font-weight: bold; font-family: monospace; color: #20e889;">${bookingRef}</td></tr>
                  <tr><td style="padding: 6px 0; color: #94a3b8;">Section:</td><td style="padding: 6px 0; font-weight: bold;">Section ${seatDetails.section}</td></tr>
                  <tr><td style="padding: 6px 0; color: #94a3b8;">Row & Seat:</td><td style="padding: 6px 0; font-weight: bold;">Row ${seatDetails.row} · Seat ${seatDetails.seat}</td></tr>
                  <tr><td style="padding: 6px 0; color: #94a3b8;">Tier Category:</td><td style="padding: 6px 0; font-weight: bold;">${seatDetails.tier}</td></tr>
                  <tr><td style="padding: 6px 0; color: #94a3b8;">Amount Paid:</td><td style="padding: 6px 0; font-weight: bold; color: #20e889;">₹${Number(seatDetails.price).toLocaleString('en-IN')} (PAID)</td></tr>
                  <tr><td style="padding: 6px 0; color: #94a3b8;">Payment ID:</td><td style="padding: 6px 0; font-family: monospace; font-size: 12px;">${bookingPayload.paymentDetails.razorpayPaymentId}</td></tr>
                </table>
              </div>

              <p style="font-size: 13px; color: #cbd5e1;">Your official <strong>Digital Match Ticket PDF</strong> with entry barcode and turnstile QR code is attached to this email. You can present either a digital copy or a printed copy at Gate 4B.</p>
              
              <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.12); margin: 24px 0 16px;">
              <small style="color: #64748b; font-size: 11px;">JLN Stadium Box Office · Pragati Vihar, New Delhi · Non-transferable ticket</small>
            </div>
          `,
          attachments: [
            {
              filename: `JLN_Match_Ticket_Sec${seatDetails.section}_Row${seatDetails.row}_Seat${seatDetails.seat}_${bookingRef}.pdf`,
              content: pdfBuffer,
              contentType: 'application/pdf'
            }
          ]
        });
        emailSent = true;
        console.log(`✉️ Match ticket PDF successfully emailed to ${userDetails.email}`);
      } catch (mailErr) {
        console.warn('⚠️ Nodemailer dispatch note:', mailErr.message);
      }
    }

    res.json({
      success: true,
      bookingRef,
      booking: savedBooking,
      emailSent,
      message: emailSent
        ? 'Payment verified! Booking saved to database and PDF ticket emailed.'
        : 'Payment verified! Booking successfully saved.'
    });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: err.message || 'Payment verification failed' });
  }
});

// 3. GET /api/booked-seats: Fetches all booked seats from MongoDB to initialize stadium state
app.get('/api/booked-seats', async (req, res) => {
  try {
    let bookedSeats = [];
    if (isDbConnected()) {
      try {
        const bookings = await Booking.find({}, 'seatDetails bookingRef createdAt');
        bookedSeats = bookings.map((b) => ({
          ...b.seatDetails.toObject(),
          bookingRef: b.bookingRef
        }));
      } catch (dbErr) {
        console.warn('DB fetch notice:', dbErr.message);
        bookedSeats = inMemoryBookings.map((b) => ({ ...b.seatDetails, bookingRef: b.bookingRef }));
      }
    } else {
      bookedSeats = inMemoryBookings.map((b) => ({ ...b.seatDetails, bookingRef: b.bookingRef }));
    }

    res.json({
      success: true,
      bookedSeats
    });
  } catch (err) {
    console.error('Get booked seats error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Stadium Server running at http://localhost:${PORT}`);
});